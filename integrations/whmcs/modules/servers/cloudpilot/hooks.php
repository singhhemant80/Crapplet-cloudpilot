<?php
/**
 * Completes activation for CloudPilot services whose server was still being built
 * when WHMCS ran CreateAccount. Runs after every WHMCS cron run (normally every 5 min).
 *
 * Safety: it only acts on Pending services for which CloudPilot ALREADY has an
 * order (i.e. WHMCS ran Create after payment). Unpaid pending services are never
 * touched, so this hook can never place an order on its own.
 * When that order is ACTIVE it re-runs the module Create, which is idempotent: it
 * re-attaches to the existing order, fills in the IP, and WHMCS marks the service
 * Active and sends its normal welcome email.
 */

if (!defined('WHMCS')) {
    die('This file cannot be accessed directly');
}

require_once __DIR__ . '/lib/Client.php';

use CloudPilot\Whmcs\ApiException;
use CloudPilot\Whmcs\Client;
use WHMCS\Database\Capsule;

add_hook('AfterCronJob', 1, function ($vars) {
    try {
        $rows = Capsule::table('tblhosting')
            ->join('tblproducts', 'tblproducts.id', '=', 'tblhosting.packageid')
            ->join('tblservers', 'tblservers.id', '=', 'tblhosting.server')
            ->where('tblproducts.servertype', 'cloudpilot')
            ->where('tblhosting.domainstatus', 'Pending')
            ->where('tblhosting.regdate', '>=', date('Y-m-d', strtotime('-14 days')))
            ->select('tblhosting.id', 'tblservers.hostname', 'tblservers.accesshash', 'tblservers.secure', 'tblservers.password')
            ->limit(100)
            ->get();
        $site = function_exists('cloudpilot_siteId') ? cloudpilot_siteId() : parse_url((string) \WHMCS\Config\Setting::getValue('SystemURL'), PHP_URL_HOST);
        foreach ($rows as $row) {
            $client = Client::fromParams(array(
                'serverhostname' => $row->hostname,
                'serveraccesshash' => $row->accesshash,
                'serversecure' => $row->secure === 'on',
                'serverpassword' => decrypt($row->password),
            ));
            try {
                $order = $client->orderByKey('whmcs:' . strtolower($site) . ':service:' . (int) $row->id);
            } catch (ApiException $e) {
                continue; // 404: no order — unpaid or never created; leave it alone
            }
            if ($order['status'] === 'ACTIVE') {
                $res = localAPI('ModuleCreate', array('serviceid' => (int) $row->id));
                if (isset($res['result']) && $res['result'] === 'success') {
                    logActivity('CloudPilot: service #' . $row->id . ' activated after provisioning completed');
                }
            } elseif (in_array($order['status'], array('FAILED', 'CANCELLED'), true)) {
                logActivity('CloudPilot: service #' . $row->id . ' provisioning failed: ' . $order['failureReason']);
            }
        }
    } catch (\Exception $e) {
        logActivity('CloudPilot activation sync failed: ' . $e->getMessage());
    }
});
