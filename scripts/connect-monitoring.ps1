$ErrorActionPreference = 'Stop'
$taskTarget = $env:VPS_SSH_TARGET
$taskKey = $env:VPS_SSH_KEY
if (-not $taskTarget) { $taskTarget = Read-Host 'Existing SSH destination (user@host or alias)' }
if (-not $taskKey) { $taskKey = Read-Host 'Existing SSH private key path' }
$taskPort = 18083
if ($env:GRAFANA_LOCAL_PORT) { $taskPort = [int]$env:GRAFANA_LOCAL_PORT }
if ($taskPort -lt 1024 -or $taskPort -gt 65535) { throw 'GRAFANA_LOCAL_PORT must be 1024-65535' }
$taskSsh = 'ssh'
if ($env:SSH_EXECUTABLE) { $taskSsh = $env:SSH_EXECUTABLE }
Write-Host "Open http://localhost:$taskPort/d/hookrelay-overview and keep this terminal open. Ctrl+C closes the tunnel."
& $taskSsh -i $taskKey -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 `
    -L "127.0.0.1:${taskPort}:127.0.0.1:18082" $taskTarget `
    'sudo -n k3s kubectl -n hookrelay-monitoring port-forward --address=127.0.0.1 service/grafana 18082:3000'
if ($LASTEXITCODE -ne 0) { throw 'Grafana tunnel disconnected or failed to start' }
