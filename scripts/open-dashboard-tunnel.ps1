# Opens the Dashboard through the saved SSH deployment target on this Windows PC.
[CmdletBinding()]
param(
    [string]$Server,
    [string]$AppDir,
    [ValidateRange(1024, 65535)][int]$LocalPort = 15150,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
if (!$Server -or !$AppDir) {
    $deployment = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../data/deploy-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (!$Server) { $Server = $deployment.server }
    if (!$AppDir) { $AppDir = $deployment.appDir }
}
if ($Server -notmatch '^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[A-Fa-f0-9:]+\])$' -or
    $AppDir -notmatch '^/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+/?$' -or $AppDir -match '(?:^|/)\.\.?(?:/|$)') {
    throw 'Check the SSH user@host and absolute Linux application directory in the deployment configuration.'
}

# Reuse only a loopback listener owned by SSH with the same destination and socket.
$forward = '127.0.0.1:{0}:{1}/data/dashboard-tunnel/console.sock' -f $LocalPort, $AppDir.TrimEnd('/')
$existing = @(Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue)
$created = $null
if ($existing.Count) {
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $existing[0].OwningProcess)
    $argsPattern = '(?:^|\s)-L\s+"?' + [regex]::Escape($forward) + '"?\s+(?:--\s+)?"?' + [regex]::Escape($Server) + '"?\s*$'
    if ($existing.Count -ne 1 -or $existing[0].LocalAddress -ne '127.0.0.1' -or $owner.Name -ne 'ssh.exe' -or $owner.CommandLine -notmatch $argsPattern) {
        throw "Port $LocalPort already belongs to another application or tunnel."
    }
} else {
    $ssh = (Get-Command ssh.exe -CommandType Application | Select-Object -First 1).Source
    $arguments = @('-nNT', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-L', $forward, '--', $Server)
    $created = Start-Process -FilePath $ssh -ArgumentList $arguments -WindowStyle Hidden -PassThru
}

# Confirm the real server granted both permissions before opening the browser.
Add-Type -AssemblyName System.Net.Http
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.UseProxy = $false
$handler.AllowAutoRedirect = $false
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(3)
$entry = "http://127.0.0.1:$LocalPort/dashboard/"
$ready = $false
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(22)
    do {
        if ($created -and $created.HasExited) { throw "SSH exited with code $($created.ExitCode). Check key authentication and the saved host key." }
        try {
            $session = $client.GetStringAsync($entry + 'api/auth/session').GetAwaiter().GetResult() | ConvertFrom-Json
            $ready = $session.mode -eq 'source' -and $session.access -eq $true -and $session.admin -eq $true
        } catch [System.Net.Http.HttpRequestException] { }
          catch [System.Threading.Tasks.TaskCanceledException] { }
        if (!$ready) { Start-Sleep -Milliseconds 350 }
    } until ($ready -or [DateTime]::UtcNow -ge $deadline)
    if (!$ready) { throw 'Dashboard did not confirm SSH access. Check its private socket and trusted-access configuration.' }
} finally {
    $client.Dispose()
    if (!$ready -and $created -and !$created.HasExited) { $created.Kill() }
}
if (!$NoBrowser) { Start-Process -FilePath $entry }
Write-Output $entry
