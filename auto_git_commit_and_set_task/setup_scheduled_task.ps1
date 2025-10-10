# PowerShell Script: Setup Git Auto Commit Task
# Requires Administrator Privileges

param(
    [switch]$Remove  # Parameter to remove existing task
)

# Check if running with Administrator privileges
if (-NOT ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Host "This script requires Administrator privileges." -ForegroundColor Red
    Write-Host "Please right-click PowerShell and select 'Run as Administrator'." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# Task name and script path
$TaskName = "GitAutoCommit"
$ScriptPath = Join-Path $PSScriptRoot "auto_git_commit.bat"

Write-Host "========================================" -ForegroundColor Green
Write-Host "    Git Auto Commit Task Setup" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

if ($Remove) {
    # Remove existing task
    Write-Host "Removing task: $TaskName" -ForegroundColor Yellow
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host "Task removed successfully!" -ForegroundColor Green
    }
    catch {
        Write-Host "Error removing task: $($_.Exception.Message)" -ForegroundColor Red
    }
    Read-Host "Press Enter to exit"
    exit 0
}

# Check if script file exists
if (-not (Test-Path $ScriptPath)) {
    Write-Host "Error: Script file not found: $ScriptPath" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Check if task with same name exists
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($ExistingTask) {
    Write-Host "Found existing task: $TaskName" -ForegroundColor Yellow
    $choice = Read-Host "Do you want to recreate it? (y/n)"
    if ($choice -ne "y" -and $choice -ne "Y") {
        Write-Host "Operation cancelled." -ForegroundColor Yellow
        Read-Host "Press Enter to exit"
        exit 0
    }
    Write-Host "Removing existing task..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Write-Host "Creating scheduled task..." -ForegroundColor Yellow

try {
    # Create trigger: Daily at 6:30 PM
    $Trigger = New-ScheduledTaskTrigger -Daily -At "6:30PM"
    
    # Create action: Execute bat script
    $Action = New-ScheduledTaskAction -Execute $ScriptPath -Argument "/silent"
    
    # Create task settings
    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RunOnlyIfNetworkAvailable
    
    # Create principal (run as current user)
    $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
    
    # Register task
    Register-ScheduledTask -TaskName $TaskName -Trigger $Trigger -Action $Action -Settings $Settings -Principal $Principal -Description "Daily Git auto commit at 6:30 PM"
    
    Write-Host ""
    Write-Host "Task created successfully!" -ForegroundColor Green
    Write-Host "Task Name: $TaskName" -ForegroundColor Cyan
    Write-Host "Execution Time: Daily 6:30 PM" -ForegroundColor Cyan
    Write-Host "Script Path: $ScriptPath" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Task will execute for the first time tomorrow at 6:30 PM." -ForegroundColor Yellow
    Write-Host "You can also manually run this task in Task Scheduler." -ForegroundColor Yellow
}
catch {
    Write-Host ""
    Write-Host "Error creating task: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Please check permissions and script path." -ForegroundColor Red
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "         Setup Complete" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green

Read-Host "Press Enter to exit"
