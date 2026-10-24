# WHMCS installation

Tested against the live CloudPilot API with WHMCS stubbed (`integrations/whmcs/tests/module_test.php`,
22 checks). Requires WHMCS 8.x, PHP 8.1+ with cURL. Validate on a staging WHMCS before production.

## 1. Get credentials

Reseller portal › WHMCS & API › **Connect billing system** (platform WHMCS, your WHMCS URL, your
WHMCS server's public IP). Copy the API key shown once.

## 2. Copy the files

```
integrations/whmcs/modules/servers/cloudpilot      →  <whmcs>/modules/servers/cloudpilot
integrations/whmcs/modules/addons/cloudpilot_wallet →  <whmcs>/modules/addons/cloudpilot_wallet   (optional)
```

## 3. Add the server

System Settings › Servers › Add New Server
- Module: **CloudPilot**
- Hostname: `api.crapplet.cloud` (or put the full URL in **Access Hash**)
- Password: the API key · Secure: ticked
- Click **Test Connection** → "Connection successful". The reseller portal now shows "Last contact".

Create a server group containing it.

## 4. Create products

System Settings › Products/Services › Create product, Module Settings tab:

| Field | Value |
|---|---|
| Module | CloudPilot, with the server group above |
| Product SKU | e.g. `VPS-2C4G` (Reseller portal › Products & prices) |
| Location code | e.g. `IN-MUM-1` |
| Default OS template ID | a template UUID from the products API |
| Report retail price | on — feeds your margin report |
| Wait for activation | 25 (seconds) |
| Automation | "Automatically setup the product as soon as the first payment is received" |

Billing cycles must be monthly, quarterly, semi-annually, annually or one time and must exist in
CloudPilot's price list for that SKU; other cycles are refused with a clear message.

**Optional OS choice**: add a configurable option named exactly `Operating System` with
sub-options `<template uuid>|Ubuntu 24.04`. WHMCS passes the part before `|`.

## 5. How it behaves

| WHMCS event | Module function | CloudPilot |
|---|---|---|
| First payment received | CreateAccount | Places the order (key `whmcs:<your-host>:service:<id>`), waits ≤25 s. Returns success only when ACTIVE; IP and username are written to the service. If still building, Create reports "being built" and the **AfterCronJob hook** finishes activation on a later cron run. |
| Retry Create / duplicate cron | CreateAccount | Re-attaches to the same order; never a second server or charge. |
| Overdue suspension | SuspendAccount | VM stopped, service SUSPENDED. |
| Payment after suspension | UnsuspendAccount | VM started. |
| Renewal invoice paid | Renew | Charges one period to your wallet, keyed by the due date being renewed. |
| Termination | TerminateAccount | VM deleted, IPs quarantined. |
| Upgrade/downgrade | ChangePackage | Not supported yet — returns an explanatory error. |
| Admin buttons | Start / Shut down / Reboot / Sync | |
| Client area | Start / Shut down / Reboot, IP, SSH login line | |

Errors appear in the WHMCS module log (Utilities › Logs › Module Log) with the CloudPilot error
code. The API key is never written to the log.

**Insufficient wallet balance**: Create fails with `insufficient_funds`; top up, then click
**Create** again — safe to repeat.

## 6. Wallet addon

System Settings › Addon Modules › CloudPilot Wallet › Activate → Configure (API URL, API key with
`wallet:read`/`wallet:write`). Addons › CloudPilot Wallet shows balance and deposits and lets
staff pay online (opens CloudPilot's checkout) or report a bank transfer.

Payments your customers make to *your* WHMCS are your revenue; they are not proof of payment to
CloudPilot, so wallet top-ups always go through CloudPilot's verified checkout or bank review.
