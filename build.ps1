# Build deepseek-gateway.exe from server.js using Node.js SEA
# Requires: Node.js 20+ (https://nodejs.org)

$ErrorActionPreference = 'Stop'

# Force UTF-8 console output
chcp 65001 | Out-Null

# Kill stale process
$running = Get-Process -Name deepseek-gateway -ErrorAction SilentlyContinue
if ($running) {
    Write-Host 'Stopping running deepseek-gateway.exe ...' -ForegroundColor Yellow
    $running | Stop-Process -Force
    Start-Sleep -Seconds 1
}

# Resolve paths relative to script location
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host '=== DeepSeek Gateway Build (Node.js SEA) ===' -ForegroundColor Cyan

# Check Node.js
try {
    $nodeVersion = node --version
    Write-Host "Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host 'Node.js not found. Install from https://nodejs.org' -ForegroundColor Red
    exit 1
}

# Create output directory
$null = New-Item -ItemType Directory -Force -Path dist

# Step 1: Write SEA config
Write-Host '[1/4] Creating SEA config...' -ForegroundColor Yellow
Set-Content -Path sea-config.json -Value '{"main":"server.js","output":"sea-prep.blob","disableExperimentalSEAWarning":true}'

# Step 2: Generate the SEA blob
Write-Host '[2/4] Generating SEA blob...' -ForegroundColor Yellow
node --experimental-sea-config sea-config.json
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Failed to generate SEA blob!' -ForegroundColor Red
    exit 1
}

# Step 3: Copy node.exe as the base binary
Write-Host '[3/4] Copying node binary...' -ForegroundColor Yellow
$nodeExe = (Get-Command node).Source
Copy-Item $nodeExe dist/deepseek-gateway.exe -Force

# On Windows, remove the digital signature so postject can modify the binary
$signtool = Get-Command signtool -ErrorAction SilentlyContinue
if ($signtool) {
    Write-Host '  Removing digital signature...' -ForegroundColor DarkGray
    & signtool remove /s dist/deepseek-gateway.exe 2>$null
} else {
    Write-Host '  signtool not found - skipping signature removal (may still work)' -ForegroundColor DarkGray
}

# Step 4: Inject the SEA blob into the binary
Write-Host '[4/4] Injecting SEA blob...' -ForegroundColor Yellow
npx postject dist/deepseek-gateway.exe NODE_SEA_BLOB sea-prep.blob `
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

if ($LASTEXITCODE -eq 0) {
    Remove-Item sea-config.json, sea-prep.blob -ErrorAction SilentlyContinue
    $size = (Get-Item dist/deepseek-gateway.exe).Length / 1MB
    $msg = "Done! dist/deepseek-gateway.exe ({0:N1} MB)" -f $size
    Write-Host ''
    Write-Host $msg -ForegroundColor Green
    Write-Host ''
    Write-Host 'Run: .\dist\deepseek-gateway.exe' -ForegroundColor Cyan
} else {
    Write-Host ''
    Write-Host 'Build failed!' -ForegroundColor Red
    Write-Host 'Try running manually:'
    Write-Host '  npm install -g postject' -ForegroundColor DarkGray
    Write-Host '  npx postject dist/deepseek-gateway.exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' -ForegroundColor DarkGray
    exit 1
}
