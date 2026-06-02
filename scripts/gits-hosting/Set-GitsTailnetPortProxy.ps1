[CmdletBinding()]
param(
    [string]$WslDistro = "",
    [string]$WslIp = "",
    [int]$LocalPort = 13773,
    [int]$TailnetHttpsPort = 8443,
    [string]$ListenAddress = "127.0.0.1",
    [switch]$UsePortProxy,
    [switch]$AllowNonLoopbackListen,
    [switch]$SkipServe,
    [switch]$SkipFunnelDisable,
    [switch]$SkipLoopbackProbe,
    [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step {
    param([string]$Message)
    Write-Host "[gits-hosting] $Message"
}

function Assert-Admin {
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this script from an elevated PowerShell session when -UsePortProxy is set so netsh can update the Windows proxy table."
    }
}

function Resolve-CommandPath {
    param(
        [string]$Name,
        [string[]]$FallbackPaths = @()
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    foreach ($path in $FallbackPaths) {
        if ($path -and (Test-Path $path)) {
            return $path
        }
    }

    throw "Missing required command: $Name"
}

function Invoke-Checked {
    param(
        [string]$Command,
        [string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed: $Command $($Arguments -join ' ')"
    }
}

function Assert-LoopbackListenAddress {
    param([string]$Address)

    if ($AllowNonLoopbackListen) {
        return
    }

    $allowed = @("127.0.0.1", "localhost", "::1")
    if ($allowed -notcontains $Address) {
        throw "Refusing non-loopback listen address '$Address'. Use -AllowNonLoopbackListen only after confirming the port is not LAN exposed."
    }
}

function Resolve-WslIp {
    param(
        [string]$WslCommand,
        [string]$Distro
    )

    $arguments = @()
    if ($Distro) {
        $arguments += "-d"
        $arguments += $Distro
    }
    $arguments += "--"
    $arguments += "hostname"
    $arguments += "-I"

    $raw = & $WslCommand @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to resolve the WSL IPv4 address."
    }

    $match = [regex]::Match($raw, "(?m)\b\d{1,3}(?:\.\d{1,3}){3}\b")
    if (-not $match.Success) {
        throw "WSL did not return an IPv4 address."
    }

    return $match.Value
}

function Test-LoopbackHttp {
    param(
        [string]$Address,
        [int]$Port
    )

    $uri = "http://${Address}:$Port/gits"
    Write-Step "Checking Windows loopback reachability: $uri"
    try {
        $response = Invoke-WebRequest -Uri $uri -Method Head -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 500) {
            throw "Unexpected HTTP status $($response.StatusCode)"
        }
    } catch {
        throw "Windows loopback cannot reach $uri. Start gits-cockpit.service first, or rerun with -UsePortProxy if localhost forwarding is unavailable. $($_.Exception.Message)"
    }
}

function Get-CommandText {
    param(
        [string]$Command,
        [string[]]$Arguments
    )

    $output = & $Command @Arguments 2>&1 | Out-String
    return @{
        ExitCode = $LASTEXITCODE
        Text = $output
    }
}

function Assert-NoFunnelOnPort {
    param(
        [string]$TailscaleCommand,
        [int]$Port
    )

    if ($SkipFunnelDisable) {
        Write-Step "Skipping Funnel verification by request."
        return
    }

    Write-Step "Checking Funnel status for :$Port"
    $result = Get-CommandText -Command $TailscaleCommand -Arguments @("funnel", "status")
    if ($result.ExitCode -ne 0) {
        Write-Step "Could not read Funnel status; continuing without changing Funnel config."
        Write-Host $result.Text
        return
    }

    $portLines = @($result.Text -split "\r?\n" | Where-Object { $_ -match ":$Port(\D|$)" })
    foreach ($line in $portLines) {
        if ($line -match "Funnel on") {
            throw "Funnel appears to be enabled on :$Port. Remove that public Funnel route before exposing GITS."
        }
    }

    Write-Host $result.Text
}

function Assert-NoBroadPortProxy {
    param(
        [string]$NetshCommand,
        [int]$Port
    )

    $result = Get-CommandText -Command $NetshCommand -Arguments @("interface", "portproxy", "show", "v4tov4")
    if ($result.ExitCode -ne 0) {
        Write-Step "Could not inspect Windows portproxy table."
        Write-Host $result.Text
        return
    }

    $broadLines = @($result.Text -split "\r?\n" | Where-Object {
        $_ -match "^\s*(0\.0\.0\.0|\*)\s+$Port\s+"
    })
    if ($broadLines.Count -gt 0) {
        throw "Unsafe broad Windows portproxy exists for port $Port. Remove it before serving GITS: $($broadLines -join '; ')"
    }

    Write-Step "Windows portproxy table"
    Write-Host $result.Text
}

function Assert-ServeTailnetOnly {
    param(
        [string]$TailscaleCommand,
        [int]$Port
    )

    Write-Step "tailscale serve status"
    $result = Get-CommandText -Command $TailscaleCommand -Arguments @("serve", "status")
    if ($result.ExitCode -ne 0) {
        throw "Could not read Tailscale Serve status. $($result.Text)"
    }

    Write-Host $result.Text

    $portLines = @($result.Text -split "\r?\n" | Where-Object { $_ -match ":$Port(\D|$)" })
    if ($portLines.Count -eq 0) {
        throw "Tailscale Serve status does not show :$Port."
    }
    foreach ($line in $portLines) {
        if ($line -match "Funnel on") {
            throw "Tailscale Serve shows :$Port as Funnel/public. Refusing to accept this config."
        }
    }
    if (($portLines -join "`n") -notmatch "tailnet only") {
        throw "Tailscale Serve status for :$Port does not explicitly say tailnet only."
    }
}

Assert-LoopbackListenAddress -Address $ListenAddress

$tailscaleCommand = Resolve-CommandPath -Name "tailscale" -FallbackPaths @("$env:ProgramFiles\Tailscale\tailscale.exe")
$netshCommand = Resolve-CommandPath -Name "netsh"

if (-not $SkipLoopbackProbe) {
    Test-LoopbackHttp -Address $ListenAddress -Port $LocalPort
}

Assert-NoFunnelOnPort -TailscaleCommand $tailscaleCommand -Port $TailnetHttpsPort
Assert-NoBroadPortProxy -NetshCommand $netshCommand -Port $LocalPort

if ($UsePortProxy) {
    Assert-Admin
    $wslCommand = Resolve-CommandPath -Name "wsl.exe"
    if (-not $WslIp) {
        $WslIp = Resolve-WslIp -WslCommand $wslCommand -Distro $WslDistro
    }

    Write-Step "Using WSL IPv4 address $WslIp"
    Write-Step "Removing any existing loopback portproxy on ${ListenAddress}:${LocalPort}"
    & $netshCommand interface portproxy delete v4tov4 listenaddress=$ListenAddress listenport=$LocalPort | Out-Null

    if (-not $VerifyOnly) {
        Write-Step "Adding loopback portproxy ${ListenAddress}:${LocalPort} -> ${WslIp}:${LocalPort}"
        Invoke-Checked -Command $netshCommand -Arguments @(
            "interface",
            "portproxy",
            "add",
            "v4tov4",
            "listenaddress=$ListenAddress",
            "listenport=$LocalPort",
            "connectaddress=$WslIp",
            "connectport=$LocalPort"
        )
    }
} else {
    Write-Step "Skipping portproxy. Windows localhost forwarding is expected to reach WSL loopback directly."
}

if (-not $SkipServe -and -not $VerifyOnly) {
    Write-Step "Publishing the loopback listener to the tailnet on :$TailnetHttpsPort"
    Invoke-Checked -Command $tailscaleCommand -Arguments @(
        "serve",
        "--bg",
        "--yes",
        "--https=$TailnetHttpsPort",
        "http://${ListenAddress}:$LocalPort"
    )
}

Assert-ServeTailnetOnly -TailscaleCommand $tailscaleCommand -Port $TailnetHttpsPort

Write-Step "tailscale funnel status"
& $tailscaleCommand funnel status
Write-Step "netsh interface portproxy show v4tov4"
& $netshCommand interface portproxy show v4tov4
