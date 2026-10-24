{* CloudPilot client area panel *}
<div class="cloudpilot-panel">
  {if $cp_error}
    <div class="alert alert-warning">{$cp_error}</div>
  {elseif !$cp_status}
    <div class="alert alert-info">Your server is being prepared.</div>
  {elseif $cp_status neq 'ACTIVE'}
    <div class="alert alert-info">Your server is being built. This page updates once it is ready.</div>
  {else}
    <table class="table table-striped">
      <tr><th>Power</th><td>{if $cp_power eq 'running'}<span class="label label-success">Running</span>{else}<span class="label label-default">{$cp_power|ucfirst}</span>{/if}</td></tr>
      <tr><th>IP address{if $cp_ips|@count gt 1}es{/if}</th><td>{foreach $cp_ips as $ip}<code>{$ip}</code> {/foreach}</td></tr>
      <tr><th>SSH login</th><td><code>ssh {$cp_username}@{$cp_ips[0]}</code></td></tr>
    </table>
  {/if}
</div>
