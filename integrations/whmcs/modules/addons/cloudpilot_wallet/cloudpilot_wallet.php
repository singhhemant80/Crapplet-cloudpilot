<?php
/**
 * CloudPilot Wallet — WHMCS admin addon.
 *
 * Shows the reseller's CloudPilot wholesale balance inside WHMCS and lets staff
 * add funds. Money paid INTO this WHMCS by end customers is the reseller's revenue
 * and is never proof of payment to CloudPilot; wallet top-ups are therefore paid
 * on CloudPilot's own checkout (verified by its payment gateway) or reported as a
 * bank transfer that CloudPilot staff confirm against their bank statement.
 */

if (!defined('WHMCS')) {
    die('This file cannot be accessed directly');
}

require_once __DIR__ . '/../../servers/cloudpilot/lib/Client.php';

use CloudPilot\Whmcs\Client;

function cloudpilot_wallet_config()
{
    return array(
        'name' => 'CloudPilot Wallet',
        'description' => 'Your CloudPilot wholesale balance, deposits and top-ups.',
        'version' => '1.0.0',
        'author' => 'CloudPilot',
        'fields' => array(
            'api_url' => array('FriendlyName' => 'API URL', 'Type' => 'text', 'Size' => '50', 'Description' => 'e.g. https://api.crapplet.cloud'),
            'api_key' => array('FriendlyName' => 'API key', 'Type' => 'password', 'Size' => '60', 'Description' => 'Needs wallet:read and wallet:write'),
        ),
    );
}

function cloudpilot_wallet_activate()
{
    return array('status' => 'success', 'description' => 'CloudPilot Wallet activated. Enter your API URL and key under Configure.');
}

function cloudpilot_wallet_deactivate()
{
    return array('status' => 'success');
}

function cloudpilot_wallet_h($s)
{
    return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
}

function cloudpilot_wallet_output($vars)
{
    $link = $vars['modulelink'];
    if (empty($vars['api_url']) || empty($vars['api_key'])) {
        echo '<div class="alert alert-warning">Configure the API URL and key under Addons › Addon Modules › CloudPilot Wallet.</div>';
        return;
    }
    $c = new Client($vars['api_url'], $vars['api_key']);
    $notice = '';

    if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['cp_action'])) {
        check_token('WHMCS.admin.default');
        try {
            $amount = \CloudPilot\Whmcs\to_minor($_POST['amount']);
            if ((int) $amount <= 0) {
                throw new \Exception('Enter an amount greater than zero.');
            }
            if ($_POST['cp_action'] === 'topup') {
                $r = $c->topup($_POST['gateway'], $amount, 'whmcs-addon-' . bin2hex(random_bytes(8)));
                if (!empty($r['checkout']['checkoutUrl'])) {
                    $notice = '<div class="alert alert-info">Payment page created. <a class="btn btn-primary btn-sm" target="_blank" rel="noopener" href="' . cloudpilot_wallet_h($r['checkout']['checkoutUrl']) . '">Pay now</a> — your balance updates once the payment is confirmed.</div>';
                } else {
                    $notice = '<div class="alert alert-info">Top-up created. Complete the payment from the CloudPilot reseller portal (Wallet).</div>';
                }
            } elseif ($_POST['cp_action'] === 'bank') {
                $c->bankTransfer($amount, (string) $_POST['reference'], (string) $_POST['note']);
                $notice = '<div class="alert alert-success">Bank transfer reported. CloudPilot credits your wallet after confirming it with their bank.</div>';
            }
        } catch (\Exception $e) {
            $notice = '<div class="alert alert-danger">' . cloudpilot_wallet_h($e->getMessage()) . '</div>';
        }
    }

    try {
        $me = $c->me();
        $deps = $c->deposits();
    } catch (\Exception $e) {
        echo '<div class="alert alert-danger">Could not reach CloudPilot: ' . cloudpilot_wallet_h($e->getMessage()) . '</div>';
        return;
    }
    $b = $me['balances'];
    $cur = cloudpilot_wallet_h($b['currency']);
    $fmt = function ($m) use ($cur) {
        return $cur . ' ' . number_format(((int) $m) / 100, 2);
    };
    $token = generate_token('plain');

    echo $notice;
    echo '<h2>' . cloudpilot_wallet_h($me['name']) . '</h2>';
    echo '<table class="table table-condensed" style="max-width:520px">';
    echo '<tr><th>Available</th><td>' . $fmt($b['availableMinor']) . '</td></tr>';
    echo '<tr><th>Held for servers being built</th><td>' . $fmt($b['reservedMinor']) . '</td></tr>';
    if ($me['model'] === 'CREDIT') {
        echo '<tr><th>Credit used</th><td>' . $fmt($b['creditUsedMinor']) . ' of ' . $fmt($b['creditLimitMinor']) . '</td></tr>';
    }
    echo '<tr><th>Can spend now</th><td><strong>' . $fmt($b['spendableMinor']) . '</strong></td></tr></table>';

    echo '<div class="row"><div class="col-md-6"><h3>Pay online</h3>';
    if (!empty($me['paymentGateways'])) {
        echo '<form method="post" action="' . cloudpilot_wallet_h($link) . '"><input type="hidden" name="token" value="' . $token . '"><input type="hidden" name="cp_action" value="topup">';
        echo '<div class="form-group"><label>Amount (' . $cur . ')</label><input class="form-control" name="amount" inputmode="decimal" required></div>';
        echo '<div class="form-group"><label>Payment method</label><select class="form-control" name="gateway">';
        foreach ($me['paymentGateways'] as $g) {
            echo '<option>' . cloudpilot_wallet_h($g) . '</option>';
        }
        echo '</select></div><button class="btn btn-primary">Create payment</button></form>';
    } else {
        echo '<p>Online payment is not enabled for your account.</p>';
    }
    echo '</div><div class="col-md-6"><h3>Report a bank transfer</h3>';
    echo '<form method="post" action="' . cloudpilot_wallet_h($link) . '"><input type="hidden" name="token" value="' . $token . '"><input type="hidden" name="cp_action" value="bank">';
    echo '<div class="form-group"><label>Amount (' . $cur . ')</label><input class="form-control" name="amount" inputmode="decimal" required></div>';
    echo '<div class="form-group"><label>UTR / transaction reference</label><input class="form-control" name="reference" required></div>';
    echo '<div class="form-group"><label>Note</label><input class="form-control" name="note"></div>';
    echo '<button class="btn btn-default">Submit for review</button></form></div></div>';

    echo '<h3>Recent deposits</h3><table class="table table-striped"><tr><th>Date</th><th>Method</th><th>Reference</th><th>Status</th><th class="text-right">Amount</th></tr>';
    foreach (array_slice($deps, 0, 20) as $d) {
        echo '<tr><td>' . cloudpilot_wallet_h(substr($d['createdAt'], 0, 16)) . '</td><td>' . cloudpilot_wallet_h($d['method'] === 'GATEWAY' ? 'Online' : 'Bank transfer') . '</td><td>' . cloudpilot_wallet_h($d['bankReference']) . '</td><td>' . cloudpilot_wallet_h($d['status']) . '</td><td class="text-right">' . $fmt($d['amountMinor']) . '</td></tr>';
    }
    echo '</table>';
}
