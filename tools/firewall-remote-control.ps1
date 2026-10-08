# Opens (or removes) the Windows Firewall rule for the DSH Remote Control page.
#
# Needs an elevated PowerShell: creating a firewall rule is an administrator operation.
#   elevated>  pwsh -File tools\firewall-remote-control.ps1
#   elevated>  pwsh -File tools\firewall-remote-control.ps1 -Remove
#
# The rule is deliberately narrow: inbound TCP on one port, Domain and Private profiles only, and
# only from the local subnet. It is inert while the plugin still binds 127.0.0.1.
param(
  [int]$Port = 19400,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$ruleName = "DSH Remote Control (TCP $Port)"

if ($Remove) {
  $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if ($null -eq $existing) {
    Write-Output "nothing to remove: $ruleName"
    exit 0
  }
  $existing | Remove-NetFirewallRule
  Write-Output "removed: $ruleName"
  exit 0
}

if ($null -ne (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
  Write-Output "already present: $ruleName"
  exit 0
}

New-NetFirewallRule `
  -DisplayName $ruleName `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $Port `
  -Profile Domain, Private `
  -RemoteAddress LocalSubnet `
  -Description 'Allow LAN peers to reach the DSH Remote Control page. Scoped to the local subnet on Domain/Private profiles; the plugin must also bind 0.0.0.0 to be reachable.' | Out-Null

Write-Output "created: $ruleName"
