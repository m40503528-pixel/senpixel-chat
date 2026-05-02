param(
    [string]$Nickname,
    [string]$RoomId = "",
    [switch]$RememberSecret
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

function Test-RelayHealth {
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/health" -Method Get -TimeoutSec 2
        return $true
    }
    catch {
        return $false
    }
}

function Assert-NodeToolchain {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw "Node.js was not found in PATH."
    }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "npm was not found in PATH."
    }
}

function Ensure-Dependencies {
    $modulePath = Join-Path $PSScriptRoot "node_modules\\ws"
    if (-not (Test-Path -LiteralPath $modulePath)) {
        Write-Host "Installing Senpixel dependencies..."
        npm install
    }
}

function Read-PlainSecret {
    $secure = Read-Host "Room secret (leave blank to skip)" -AsSecureString
    if (-not $secure.Length) {
        return ""
    }

    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}

Assert-NodeToolchain
Ensure-Dependencies

if (-not $Nickname) {
    $Nickname = Read-Host "Nickname"
}

if (-not $Nickname) {
    throw "Nickname is required."
}

if ($RoomId) {
    $customRoom = Read-Host "Room id [$RoomId]"
    if ($customRoom) {
        $RoomId = $customRoom.Trim()
    }
}
else {
    $customRoom = Read-Host "Room id [main room]"
    if ($customRoom) {
        $RoomId = $customRoom.Trim()
    }
}

$RoomSecret = Read-PlainSecret

if (-not (Test-RelayHealth)) {
    $windowCommand = "Set-Location -LiteralPath '$PSScriptRoot'; npm start"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $windowCommand | Out-Null

    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        if (Test-RelayHealth) {
            break
        }
    }
}

if (-not (Test-RelayHealth)) {
    throw "Relay is not reachable on http://127.0.0.1:8000"
}

$launchPayload = @{
    nickname        = $Nickname
    room_id         = $RoomId
    room_secret     = $RoomSecret
    remember_secret = [bool]$RememberSecret
    auto_start      = $true
}

$launch = Invoke-RestMethod `
    -Uri "http://127.0.0.1:8000/api/launch" `
    -Method Post `
    -ContentType "application/json" `
    -Body ($launchPayload | ConvertTo-Json)

$targetUrl = "http://127.0.0.1:8000/?launch=$($launch.token)"
Start-Process $targetUrl | Out-Null

Write-Host ""
Write-Host "Senpixel ready."
Write-Host "Nickname: $Nickname"
if ($RoomId) {
    Write-Host "Room id : $RoomId"
}
Write-Host "URL     : $targetUrl"
