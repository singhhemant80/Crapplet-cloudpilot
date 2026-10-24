<?php
/**
 * Runs the CloudPilot WHMCS module against a live CloudPilot API (dev or staging)
 * with WHMCS functions stubbed. Exercises the full reseller lifecycle including
 * duplicate calls that WHMCS can produce.
 *
 *   CP_API_URL=http://localhost:4000 CP_API_KEY=cp_... php tests/module_test.php
 */

define('WHMCS', true);
$GLOBALS['CONFIG']['SystemURL'] = 'https://billing.module-test.example/';

$GLOBALS['__local_api_calls'] = array();
function localAPI($cmd, $args)
{
    $GLOBALS['__local_api_calls'][] = array($cmd, $args);
    return array('result' => 'success');
}
function logModuleCall($module, $action, $request, $response)
{
    if (strpos((string) $request, getenv('CP_API_KEY')) !== false || strpos((string) $response, getenv('CP_API_KEY')) !== false) {
        fwrite(STDERR, "API key leaked into module log!\n");
        exit(1);
    }
}

require __DIR__ . '/../modules/servers/cloudpilot/cloudpilot.php';

$failures = 0;
function check($label, $cond, $detail = '')
{
    global $failures;
    echo ($cond ? "  ok   " : "  FAIL ") . $label . ($cond ? '' : ' — ' . $detail) . "\n";
    if (!$cond) {
        $failures++;
    }
}

$url = getenv('CP_API_URL') ?: 'http://localhost:4000';
$key = getenv('CP_API_KEY');
if (!$key) {
    fwrite(STDERR, "Set CP_API_KEY\n");
    exit(2);
}
$u = parse_url($url);
$client = new CloudPilot\Whmcs\Client($url, $key);
$products = $client->products();
$tpl = $products[0]['locations'][0]['templates'][0]['id'];
$sku = $products[0]['sku'];
$loc = $products[0]['locations'][0]['code'];
$price = (int) $products[0]['pricing'][0]['amountMinor'];
$serviceId = random_int(100000, 999999);

$model = new stdClass();
$model->billingcycle = 'Monthly';
$model->amount = '899.00';
$model->nextduedate = date('Y-m-d', strtotime('+1 month'));

$params = array(
    'serviceid' => $serviceId,
    'userid' => 4242,
    'domain' => 'whmcs-' . $serviceId . '.example.net',
    'password' => 'short', // forces the module to generate a strong one
    'configoption1' => $sku,
    'configoption2' => $loc,
    'configoption3' => $tpl,
    'configoption4' => 'on',
    'configoption5' => '20',
    'configoptions' => array(),
    'clientsdetails' => array('fullname' => 'Module Test', 'companyname' => 'ModTest Ltd', 'email' => 'mod@test.example', 'currency_code' => 'INR'),
    'model' => $model,
    'serverhostname' => $u['host'] . (isset($u['port']) ? ':' . $u['port'] : ''),
    'serversecure' => $u['scheme'] === 'https',
    'serveraccesshash' => '',
    'serverpassword' => $key,
);

echo "WHMCS module test against $url (service $serviceId)\n";
$before = (int) $client->wallet()['availableMinor'];

$t = cloudpilot_TestConnection($params);
check('TestConnection succeeds', $t['success'] === true, json_encode($t));

$bad = $params;
$bad['serverpassword'] = 'cp_0000000000000000_' . str_repeat('A', 43);
$t = cloudpilot_TestConnection($bad);
check('TestConnection rejects a wrong key', $t['success'] === false);

$r = cloudpilot_CreateAccount($params);
check('CreateAccount returns success once the server is ACTIVE', $r === 'success', $r);
$upd = array_values(array_filter($GLOBALS['__local_api_calls'], function ($c) { return isset($c[1]['dedicatedip']); }));
check('Dedicated IP written back to WHMCS', !empty($upd) && filter_var($upd[0][1]['dedicatedip'], FILTER_VALIDATE_IP), json_encode($upd));
$pw = array_values(array_filter($GLOBALS['__local_api_calls'], function ($c) { return isset($c[1]['servicepassword']); }));
check('Weak WHMCS password replaced with a generated one', !empty($pw) && strlen($pw[0][1]['servicepassword']) >= 12);

$r2 = cloudpilot_CreateAccount($params);
check('Repeated CreateAccount is idempotent', $r2 === 'success', $r2);
$afterCreate = (int) $client->wallet()['availableMinor'];
check('Wallet charged exactly once for the order', $before - $afterCreate === $price, "before $before after $afterCreate price $price");

$order = $client->orderByKey('whmcs:billing.module-test.example:service:' . $serviceId);
check('Retail price reported for margins', $order['retailMinor'] === '89900', json_encode($order['retailMinor']));

$tab = cloudpilot_AdminServicesTabFields($params);
check('Admin tab shows the order', strpos($tab['CloudPilot order'], 'ACTIVE') !== false, json_encode($tab));

check('Reboot button', cloudpilot_reboot($params) === 'success');
$params['suspendreason'] = 'Overdue on invoice';
check('SuspendAccount', ($s = cloudpilot_SuspendAccount($params)) === 'success', $s);
check('SuspendAccount again is harmless', ($s = cloudpilot_SuspendAccount($params)) === 'success', $s);
check('Reboot refused while suspended', strpos(cloudpilot_reboot($params), 'service_not_active') !== false);
check('UnsuspendAccount', ($s = cloudpilot_UnsuspendAccount($params)) === 'success', $s);

check('Renew', ($s = cloudpilot_Renew($params)) === 'success', $s);
check('Renew same period again (duplicate hook)', ($s = cloudpilot_Renew($params)) === 'success', $s);
$afterRenew = (int) $client->wallet()['availableMinor'];
check('Renewal charged exactly once', $afterCreate - $afterRenew === $price, "diff " . ($afterCreate - $afterRenew));

check('ChangePackage explains it is unsupported', strpos(cloudpilot_ChangePackage($params), 'not available') !== false);
check('TerminateAccount', ($s = cloudpilot_TerminateAccount($params)) === 'success', $s);
$order = $client->orderByKey('whmcs:billing.module-test.example:service:' . $serviceId);
check('Server terminated in CloudPilot', $order['service']['status'] === 'TERMINATED', $order['service']['status']);

$ghost = $params;
$ghost['serviceid'] = $serviceId + 1;
check('Terminate of a never-provisioned service is a no-op', cloudpilot_TerminateAccount($ghost) === 'success');

$monthlyOnly = $params;
$monthlyOnly['serviceid'] = $serviceId + 2;
$monthlyOnly['model'] = clone $model;
$monthlyOnly['model']->billingcycle = 'Biennially';
check('Unsupported billing cycle is reported, nothing ordered', strpos(cloudpilot_CreateAccount($monthlyOnly), 'not offered') !== false);

echo $failures ? "\n$failures check(s) failed\n" : "\nAll checks passed\n";
exit($failures ? 1 : 0);
