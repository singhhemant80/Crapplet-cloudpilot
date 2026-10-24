<?php
/**
 * CloudPilot provisioning module for WHMCS.
 *
 * Lets a reseller sell CloudPilot VPS plans from their own WHMCS. Payment from the
 * end customer is collected by the reseller's WHMCS; CloudPilot charges the
 * reseller's wholesale wallet. CloudPilot stays the source of truth for pricing,
 * funds, IP allocation and provisioning.
 *
 * Every write call carries an idempotency key derived from the WHMCS service id,
 * so WHMCS retries, double-clicks and duplicate cron runs can never create a
 * second server or charge the wallet twice.
 *
 * Server setup (System Settings › Servers):
 *   Hostname       : CloudPilot API host, e.g. api.crapplet.cloud
 *   Access Hash    : (optional) full API base URL, overrides hostname, e.g. https://api.crapplet.cloud
 *   Password       : the reseller API key (cp_xxx_yyy)
 *   Secure         : ticked (https)
 */

if (!defined('WHMCS')) {
    die('This file cannot be accessed directly');
}

require_once __DIR__ . '/lib/Client.php';

use CloudPilot\Whmcs\ApiException;
use CloudPilot\Whmcs\Client;

const CLOUDPILOT_MODULE_VERSION = '1.0.0';

function cloudpilot_MetaData()
{
    return array(
        'DisplayName' => 'CloudPilot',
        'APIVersion' => '1.1',
        'RequiresServer' => true,
        'DefaultNonSSLPort' => '80',
        'DefaultSSLPort' => '443',
        'ServiceSingleSignOnLabel' => false,
        'AdminSingleSignOnLabel' => false,
    );
}

function cloudpilot_ConfigOptions()
{
    return array(
        'Product SKU' => array('Type' => 'text', 'Size' => '25', 'Description' => 'CloudPilot product code, e.g. VPS-2C4G (see Products & prices in the reseller portal)'),
        'Location code' => array('Type' => 'text', 'Size' => '25', 'Description' => 'Datacenter code, e.g. IN-MUM-1'),
        'Default OS template ID' => array('Type' => 'text', 'Size' => '40', 'Description' => 'Used when the order has no "Operating System" configurable option'),
        'Report retail price' => array('Type' => 'yesno', 'Description' => 'Send the client price to CloudPilot for margin reports', 'Default' => 'on'),
        'Wait for activation (seconds)' => array('Type' => 'text', 'Size' => '5', 'Default' => '25', 'Description' => 'How long Create waits for the server before handing over to the cron sync'),
    );
}

// ───────────────────────────────────────── helpers

/** Stable identifier of this WHMCS installation, used in idempotency keys. */
function cloudpilot_siteId()
{
    $url = '';
    if (class_exists('\WHMCS\Config\Setting')) {
        $url = (string) \WHMCS\Config\Setting::getValue('SystemURL');
    } elseif (isset($GLOBALS['CONFIG']['SystemURL'])) {
        $url = (string) $GLOBALS['CONFIG']['SystemURL'];
    }
    $host = parse_url($url, PHP_URL_HOST);
    return $host ? strtolower($host) : 'whmcs';
}

function cloudpilot_siteUrl()
{
    if (class_exists('\WHMCS\Config\Setting')) {
        return rtrim((string) \WHMCS\Config\Setting::getValue('SystemURL'), '/');
    }
    return isset($GLOBALS['CONFIG']['SystemURL']) ? rtrim($GLOBALS['CONFIG']['SystemURL'], '/') : '';
}

function cloudpilot_orderKey(array $params)
{
    return 'whmcs:' . cloudpilot_siteId() . ':service:' . (int) $params['serviceid'];
}

function cloudpilot_cycle($whmcsCycle)
{
    $map = array(
        'monthly' => 'MONTHLY',
        'quarterly' => 'QUARTERLY',
        'semi-annually' => 'SEMIANNUAL',
        'annually' => 'ANNUAL',
        'one time' => 'ONE_TIME',
        'free account' => 'MONTHLY',
    );
    $k = strtolower(trim((string) $whmcsCycle));
    if (!isset($map[$k])) {
        throw new ApiException('Billing cycle "' . $whmcsCycle . '" is not offered by CloudPilot (use monthly, quarterly, semi-annually, annually or one time)', 'unsupported_cycle', 422);
    }
    return $map[$k];
}

function cloudpilot_modelValue(array $params, $field, $default = null)
{
    if (isset($params['model']) && is_object($params['model']) && isset($params['model']->{$field})) {
        return $params['model']->{$field};
    }
    return $default;
}

function cloudpilot_hostname(array $params)
{
    $d = strtolower(trim((string) $params['domain']));
    if ($d !== '' && preg_match('/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/', $d)) {
        return $d;
    }
    return 'vps' . (int) $params['serviceid'];
}

/** Root password: reuse WHMCS's if strong enough, otherwise generate one and save it back. */
function cloudpilot_password(array $params)
{
    $pw = (string) $params['password'];
    if (strlen($pw) >= 12) {
        return $pw;
    }
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#%^*-_';
    $pw = '';
    for ($i = 0; $i < 20; $i++) {
        $pw .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    }
    if (function_exists('localAPI')) {
        localAPI('UpdateClientProduct', array('serviceid' => (int) $params['serviceid'], 'servicepassword' => $pw));
    }
    return $pw;
}

/** Looks up our order for this WHMCS service; null if none exists yet. */
function cloudpilot_findOrder(Client $c, array $params)
{
    try {
        return $c->orderByKey(cloudpilot_orderKey($params));
    } catch (ApiException $e) {
        if ($e->httpStatus === 404) {
            return null;
        }
        throw $e;
    }
}

function cloudpilot_serviceId(Client $c, array $params)
{
    $o = cloudpilot_findOrder($c, $params);
    if (!$o || empty($o['service']['id'])) {
        throw new ApiException('No CloudPilot server is linked to this service yet', 'not_provisioned', 404);
    }
    return $o['service']['id'];
}

/** Copies IP and login details from an ACTIVE order into the WHMCS service. */
function cloudpilot_applyActive(array $params, array $order)
{
    $ips = array();
    foreach ($order['ips'] as $ip) {
        $ips[] = $ip['address'];
    }
    if (function_exists('localAPI')) {
        localAPI('UpdateClientProduct', array(
            'serviceid' => (int) $params['serviceid'],
            'dedicatedip' => isset($ips[0]) ? $ips[0] : '',
            'assignedips' => implode("\n", array_slice($ips, 1)),
            'serviceusername' => isset($order['service']['username']) ? $order['service']['username'] : 'cloud',
        ));
    }
}

function cloudpilot_error(\Exception $e)
{
    if ($e instanceof ApiException) {
        return 'CloudPilot: ' . $e->getMessage() . ' (' . $e->errorCode . ')';
    }
    return 'CloudPilot: ' . $e->getMessage();
}

// ───────────────────────────────────────── module functions

function cloudpilot_TestConnection(array $params)
{
    try {
        $r = Client::fromParams($params)->heartbeat(cloudpilot_siteUrl(), CLOUDPILOT_MODULE_VERSION);
        return array('success' => !empty($r['ok']), 'error' => empty($r['ok']) ? 'Unexpected response' : '');
    } catch (\Exception $e) {
        return array('success' => false, 'error' => cloudpilot_error($e));
    }
}

/**
 * Places (or re-attaches to) the CloudPilot order. Returns "success" only once the
 * server is verified ACTIVE; while it is still building, returns a pending message
 * and the cron hook completes activation later. Retrying is always safe.
 */
function cloudpilot_CreateAccount(array $params)
{
    try {
        $c = Client::fromParams($params);
        $key = cloudpilot_orderKey($params);
        $order = cloudpilot_findOrder($c, $params);

        if (!$order) {
            $template = '';
            if (!empty($params['configoptions']['Operating System'])) {
                $template = $params['configoptions']['Operating System'];
            } elseif (!empty($params['configoption3'])) {
                $template = $params['configoption3'];
            }
            if ($template === '') {
                return 'CloudPilot: no OS template configured for this product';
            }
            $client = isset($params['clientsdetails']) ? $params['clientsdetails'] : array();
            $body = array(
                'productSku' => trim($params['configoption1']),
                'locationCode' => trim($params['configoption2']),
                'templateId' => trim($template),
                'cycle' => cloudpilot_cycle(cloudpilot_modelValue($params, 'billingcycle', 'Monthly')),
                'hostname' => cloudpilot_hostname($params),
                'password' => cloudpilot_password($params),
                'source' => 'WHMCS',
                'customer' => array(
                    'externalRef' => (string) $params['userid'],
                    'name' => trim((isset($client['companyname']) && $client['companyname'] !== '' ? $client['companyname'] : (isset($client['fullname']) ? $client['fullname'] : 'Client ' . $params['userid']))),
                    'email' => isset($client['email']) && filter_var($client['email'], FILTER_VALIDATE_EMAIL) ? $client['email'] : null,
                ),
            );
            if ($body['customer']['email'] === null) {
                unset($body['customer']['email']);
            }
            if ($params['configoption4'] === 'on' || $params['configoption4'] === true) {
                $amount = cloudpilot_modelValue($params, 'amount');
                $currency = isset($client['currency_code']) ? $client['currency_code'] : null;
                if ($amount !== null && $currency) {
                    $body['retail'] = array('amountMinor' => \CloudPilot\Whmcs\to_minor($amount), 'currency' => strtoupper($currency));
                }
            }
            $order = $c->createOrder($body, $key);
        }

        $wait = max(0, min(60, (int) ($params['configoption5'] !== '' ? $params['configoption5'] : 25)));
        $deadline = time() + $wait;
        while (in_array($order['status'], array('PAID_OR_AUTHORIZED', 'QUEUED', 'PROVISIONING', 'CONFIGURING_NETWORK', 'VERIFYING'), true) && time() < $deadline) {
            sleep(2);
            $order = $c->orderByKey($key);
        }

        switch ($order['status']) {
            case 'ACTIVE':
                cloudpilot_applyActive($params, $order);
                return 'success';
            case 'FAILED':
            case 'CANCELLED':
                return 'CloudPilot order #' . $order['number'] . ' failed: ' . $order['failureReason'] . ' — the wholesale charge was returned to your wallet. Fix the cause and create a new service.';
            case 'NEEDS_ATTENTION':
                return 'CloudPilot order #' . $order['number'] . ' needs attention from CloudPilot support; funds remain held. No action needed here.';
            case 'PAID_OR_AUTHORIZED':
                return 'CloudPilot order #' . $order['number'] . ' is awaiting approval by CloudPilot staff. It will activate automatically.';
            default:
                return 'CloudPilot order #' . $order['number'] . ' is being built (' . strtolower($order['status']) . '). It will activate automatically within a few minutes.';
        }
    } catch (\Exception $e) {
        return cloudpilot_error($e);
    }
}

function cloudpilot_runAction(array $params, $action, $reason = null)
{
    try {
        $c = Client::fromParams($params);
        $sid = cloudpilot_serviceId($c, $params);
        $r = $c->serviceAction($sid, $action, $reason, 'whmcs-' . $action . '-' . (int) $params['serviceid'] . '-' . bin2hex(random_bytes(6)));
        if (empty($r['done'])) {
            return 'CloudPilot accepted the ' . $action . ' request; it is still running (operation ' . $r['operationId'] . ').';
        }
        return 'success';
    } catch (\Exception $e) {
        return cloudpilot_error($e);
    }
}

function cloudpilot_SuspendAccount(array $params)
{
    return cloudpilot_runAction($params, 'suspend', isset($params['suspendreason']) ? (string) $params['suspendreason'] : 'Suspended by WHMCS');
}

function cloudpilot_UnsuspendAccount(array $params)
{
    return cloudpilot_runAction($params, 'unsuspend');
}

function cloudpilot_TerminateAccount(array $params)
{
    try {
        $c = Client::fromParams($params);
        if (!cloudpilot_findOrder($c, $params)) {
            return 'success'; // nothing was ever provisioned
        }
    } catch (\Exception $e) {
        return cloudpilot_error($e);
    }
    return cloudpilot_runAction($params, 'terminate', 'Terminated by WHMCS');
}

/**
 * Called by WHMCS when a renewal invoice is paid. The key is tied to the due date
 * being renewed, so re-running the hook for the same period never charges twice.
 */
function cloudpilot_Renew(array $params)
{
    try {
        $c = Client::fromParams($params);
        $sid = cloudpilot_serviceId($c, $params);
        $due = (string) cloudpilot_modelValue($params, 'nextduedate', '');
        if ($due instanceof \DateTimeInterface) {
            $due = $due->format('Y-m-d');
        }
        $key = 'whmcs:' . cloudpilot_siteId() . ':renew:' . (int) $params['serviceid'] . ':' . substr((string) $due, 0, 10);
        $c->renew($sid, $key);
        return 'success';
    } catch (\Exception $e) {
        return cloudpilot_error($e);
    }
}

function cloudpilot_ChangePackage(array $params)
{
    return 'CloudPilot: plan upgrades and downgrades are not available yet. Create a new service and migrate, or contact CloudPilot support.';
}

function cloudpilot_AdminCustomButtonArray()
{
    return array('Start' => 'start', 'Shut down' => 'shutdown', 'Reboot' => 'reboot', 'Sync from CloudPilot' => 'sync');
}

function cloudpilot_ClientAreaCustomButtonArray()
{
    return array('Start' => 'start', 'Shut down' => 'shutdown', 'Reboot' => 'reboot');
}

function cloudpilot_start(array $params)
{
    return cloudpilot_runAction($params, 'start');
}

function cloudpilot_shutdown(array $params)
{
    return cloudpilot_runAction($params, 'shutdown');
}

function cloudpilot_reboot(array $params)
{
    return cloudpilot_runAction($params, 'reboot');
}

/** Re-reads the order and refreshes IP/login details in WHMCS. */
function cloudpilot_sync(array $params)
{
    try {
        $order = cloudpilot_findOrder(Client::fromParams($params), $params);
        if (!$order) {
            return 'No CloudPilot order exists for this service';
        }
        if ($order['status'] === 'ACTIVE') {
            cloudpilot_applyActive($params, $order);
        }
        return 'success';
    } catch (\Exception $e) {
        return cloudpilot_error($e);
    }
}

function cloudpilot_AdminServicesTabFields(array $params)
{
    try {
        $c = Client::fromParams($params);
        $o = cloudpilot_findOrder($c, $params);
        if (!$o) {
            return array('CloudPilot' => 'No order placed yet (key ' . htmlspecialchars(cloudpilot_orderKey($params)) . ')');
        }
        $ips = array();
        foreach ($o['ips'] as $ip) {
            $ips[] = $ip['address'] . ' (' . strtolower($ip['status']) . ')';
        }
        $fields = array(
            'CloudPilot order' => '#' . (int) $o['number'] . ' — ' . htmlspecialchars($o['status']),
            'Wholesale charge' => htmlspecialchars(\CloudPilot\Whmcs\from_minor($o['wholesaleMinor']) . ' ' . $o['currency']),
            'IP addresses' => htmlspecialchars(implode(', ', $ips)),
        );
        if (!empty($o['service']['status'])) {
            $fields['Server status'] = htmlspecialchars($o['service']['status']);
        }
        if (!empty($o['failureReason'])) {
            $fields['Provisioning error'] = '<span style="color:#b42318">' . htmlspecialchars($o['failureReason']) . '</span>';
        }
        $last = end($o['events']);
        if ($last) {
            $fields['Last event'] = htmlspecialchars($last['message'] . ' (' . $last['createdAt'] . ')');
        }
        return $fields;
    } catch (\Exception $e) {
        return array('CloudPilot' => htmlspecialchars(cloudpilot_error($e)));
    }
}

function cloudpilot_ClientArea(array $params)
{
    $vars = array('cp_status' => null, 'cp_power' => null, 'cp_ips' => array(), 'cp_error' => null, 'cp_username' => 'cloud');
    try {
        $c = Client::fromParams($params);
        $o = cloudpilot_findOrder($c, $params);
        if ($o) {
            $vars['cp_status'] = $o['status'];
            foreach ($o['ips'] as $ip) {
                $vars['cp_ips'][] = $ip['address'];
            }
            if (!empty($o['service']['id']) && in_array($o['service']['status'], array('ACTIVE', 'SUSPENDED'), true)) {
                $vars['cp_username'] = $o['service']['username'];
                $st = $c->serviceStatus($o['service']['id']);
                $vars['cp_power'] = $st['power'];
            }
        }
    } catch (\Exception $e) {
        $vars['cp_error'] = 'Server details are temporarily unavailable.';
    }
    return array('templatefile' => 'templates/clientarea', 'vars' => $vars);
}
