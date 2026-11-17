# Automated Live Terminal Demonstration Script
# Owner: Adarsh Sharma - Governance / AI Safety Agent
# Run this inside your Windows PowerShell window:
#    powershell -ExecutionPolicy Bypass -File .\record_live_terminal.ps1

function Type-Command {
    param([string]$cmd)
    Write-Host "PS C:\Users\hp\Desktop\EHR> " -NoNewline -ForegroundColor White
    foreach ($char in $cmd.ToCharArray()) {
        Write-Host $char -NoNewline -ForegroundColor White
        Start-Sleep -Milliseconds 60
    }
    Write-Host ""
    Start-Sleep -Milliseconds 350
}

Clear-Host
Write-Host "Windows PowerShell 5.1"
Write-Host "Copyright (C) Microsoft Corporation. All rights reserved."
Write-Host ""
Start-Sleep -Milliseconds 800

# 1. Directory Listing
Type-Command "dir"
Get-ChildItem -Path . | Format-Table -Property Mode, LastWriteTime, Length, Name
Start-Sleep -Seconds 1

# 2. Live Governance Demo
Type-Command "npm run demo"
node demo-governance.js
Start-Sleep -Seconds 2

# 3. Unit Tests
Type-Command "npm test"
node --test agents/__tests__/governance-agent.test.js
Start-Sleep -Seconds 1

Write-Host "PS C:\Users\hp\Desktop\EHR> " -NoNewline -ForegroundColor White

