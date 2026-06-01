[CmdletBinding()]
param(
    [string]$WslDistro = "",
    [string]$WslIp = "",
    [int]$LocalPort = 13773,
    [int]$TailnetHttpsPort = 8443,
    [string]$ListenAddress = "127.0.0.1",
    [switch]$SkipServe,
    [switch]$SkipFunnelDisable
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
        throw "Run this script from an elevated PowerShell session so netsh portproxy can update the Windows proxy table."
    }
}

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $Name"
    }
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

function Resolve-WslIp {
    param([string]$Distro)

    $arguments = @()
    if ($Distro) {
        $arguments += "-d"
        $arguments += $Distro
    }
    $arguments += "--"
    $arguments += "hostname"
    $arguments += "-I"

    $raw = & wsl.exe @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to resolve the WSL IPv4 address."
    }

    $match = [regex]::Match($raw, "(?m)\b\d{1,3}(?:\.\d{1,3}){3}\b")
    if (-not $match.Success) {
        throw "WSL did not return an IPv4 address."
    }

    return $match.Value
}

Assert-Admin
Assert-Command netsh
Assert-Command tailscale
Assert-Command wsl.exe

if (-not $WslIp) {
    $WslIp = Resolve-WslIp -Distro $WslDistro
}

Write-Step "Using WSL IPv4 address $WslIp"
Write-Step "Removing any existing loopback portproxy on ${ListenAddress}:${LocalPort}"
& netsh interface portproxy delete v4tov4 listenaddress=$ListenAddress listenport=$LocalPort | Out-Null

Write-Step "Adding loopback portproxy ${ListenAddress}:${LocalPort} -> ${WslIp}:${LocalPort}"
Invoke-Checked -Command netsh -Arguments @(
    "interface",
    "portproxy",
    "add",
    "v4tov4",
    "listenaddress=$ListenAddress",
    "listenport=$LocalPort",
    "connectaddress=$WslIp",
    "connectport=$LocalPort"
)

if (-not $SkipFunnelDisable) {
    Write-Step "Disabling Funnel on :$TailnetHttpsPort if it exists"
    try {
        Invoke-Checked -Command tailscale -Arguments @(
            "funnel",
            "--https=$TailnetHttpsPort",
            "http://${ListenAddress}:$LocalPort",
            "off"
        )
    } catch {
        Write-Step "No matching Funnel route was disabled."
    }
}

if (-not $SkipServe) {
    Write-Step "Publishing the loopback listener to the tailnet on :$TailnetHttpsPort"
    Invoke-Checked -Command tailscale -Arguments @(
        "serve",
        "--bg",
        "--https=$TailnetHttpsPort",
        "http://${ListenAddress}:$LocalPort"
    )
}

Write-Step "tailscale serve status"
& tailscale serve status
Write-Step "tailscale funnel status"
& tailscale funnel status
Write-Step "netsh interface portproxy show v4tov4"
& netsh interface portproxy show v4tov4
