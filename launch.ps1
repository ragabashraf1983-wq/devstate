$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$listener = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()

$env:PORT = "$port"
$bundledNode = Join-Path $root "runtime\node.exe"
$node = if (Test-Path $bundledNode) { $bundledNode } else { "node.exe" }
Start-Process -FilePath $node -ArgumentList "server.js" -WorkingDirectory $root -WindowStyle Hidden

$url = "http://localhost:$port"
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$url/api/projects" -TimeoutSec 1 | Out-Null
    Start-Process $url
    exit
  } catch {
    Start-Sleep -Milliseconds 250
  }
}
