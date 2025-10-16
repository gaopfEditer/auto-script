# PowerShell Script: Setup Shutdown and Startup Git Tasks
# Requires Administrator Privileges

param(
    [switch]$Remove,  # Parameter to remove existing tasks
    [string]$GitPath = ""  # Git repository path
)

# Check if running with Administrator privileges
if (-NOT ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Host "This script requires Administrator privileges." -ForegroundColor Red
    Write-Host "Please right-click PowerShell and select 'Run as Administrator'." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# Task names and script paths
$ShutdownTaskName = "GitShutdownCommit"
$StartupTaskName = "GitStartupPull"
$ShutdownScriptPath = Join-Path $PSScriptRoot "shutdown_git_commit.bat"
$StartupScriptPath = Join-Path $PSScriptRoot "startup_git_pull.bat"

Write-Host "========================================" -ForegroundColor Green
Write-Host "  Git Shutdown/Startup Task Setup" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

# If GitPath is provided, update the script files
if ($GitPath -ne "") {
    Write-Host "Updating script files with Git path: $GitPath" -ForegroundColor Yellow
    
    # Update shutdown script
    $ShutdownScript = Join-Path $PSScriptRoot "shutdown_git_commit.bat"
    if (Test-Path $ShutdownScript) {
        $Content = Get-Content $ShutdownScript -Raw
        $Content = $Content -replace 'set "TARGET_DIR=.*"', "set `"TARGET_DIR=$GitPath`""
        Set-Content $ShutdownScript $Content -Encoding UTF8
        Write-Host "Updated shutdown script" -ForegroundColor Green
    }
    
    # Update startup script
    $StartupScript = Join-Path $PSScriptRoot "startup_git_pull.bat"
    if (Test-Path $StartupScript) {
        $Content = Get-Content $StartupScript -Raw
        $Content = $Content -replace 'set "TARGET_DIR=.*"', "set `"TARGET_DIR=$GitPath`""
        Set-Content $StartupScript $Content -Encoding UTF8
        Write-Host "Updated startup script" -ForegroundColor Green
    }
    
    Write-Host ""
}

if ($Remove) {
    # Remove existing tasks
    Write-Host "Removing existing tasks..." -ForegroundColor Yellow
    
    try {
        Unregister-ScheduledTask -TaskName $ShutdownTaskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "Shutdown task removed successfully!" -ForegroundColor Green
    }
    catch {
        Write-Host "Error removing shutdown task: $($_.Exception.Message)" -ForegroundColor Red
    }
    
    try {
        Unregister-ScheduledTask -TaskName $StartupTaskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "Startup task removed successfully!" -ForegroundColor Green
    }
    catch {
        Write-Host "Error removing startup task: $($_.Exception.Message)" -ForegroundColor Red
    }
    
    Read-Host "Press Enter to exit"
    exit 0
}

# Check if script files exist
if (-not (Test-Path $ShutdownScriptPath)) {
    Write-Host "Error: Shutdown script not found: $ShutdownScriptPath" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

if (-not (Test-Path $StartupScriptPath)) {
    Write-Host "Error: Startup script not found: $StartupScriptPath" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Function to create shutdown task
function Create-ShutdownTask {
    Write-Host "Creating shutdown task..." -ForegroundColor Yellow
    
    try {
        # Create trigger: At system shutdown
        $Trigger = New-ScheduledTaskTrigger -AtStartup
        $Trigger.Enabled = $false  # We'll enable it manually for shutdown
        
        # Create action: Execute shutdown script
        $Action = New-ScheduledTaskAction -Execute $ShutdownScriptPath
        
        # Create task settings
        $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        
        # Create principal (run as SYSTEM for shutdown)
        $Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
        
        # Register task
        Register-ScheduledTask -TaskName $ShutdownTaskName -Trigger $Trigger -Action $Action -Settings $Settings -Principal $Principal -Description "Git auto commit on system shutdown"
        
        Write-Host "Shutdown task created successfully!" -ForegroundColor Green
    }
    catch {
        Write-Host "Error creating shutdown task: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
    return $true
}

# Function to create startup task
function Create-StartupTask {
    Write-Host "Creating startup task..." -ForegroundColor Yellow
    
    try {
        # Create trigger: At system startup
        $Trigger = New-ScheduledTaskTrigger -AtStartup
        
        # Create action: Execute startup script
        $Action = New-ScheduledTaskAction -Execute $StartupScriptPath
        
        # Create task settings
        $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RunOnlyIfNetworkAvailable
        
        # Create principal (run as current user)
        $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
        
        # Register task
        Register-ScheduledTask -TaskName $StartupTaskName -Trigger $Trigger -Action $Action -Settings $Settings -Principal $Principal -Description "Git auto pull on system startup"
        
        Write-Host "Startup task created successfully!" -ForegroundColor Green
    }
    catch {
        Write-Host "Error creating startup task: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
    return $true
}

# Check for existing tasks and remove if needed
$ExistingShutdownTask = Get-ScheduledTask -TaskName $ShutdownTaskName -ErrorAction SilentlyContinue
$ExistingStartupTask = Get-ScheduledTask -TaskName $StartupTaskName -ErrorAction SilentlyContinue

if ($ExistingShutdownTask -or $ExistingStartupTask) {
    Write-Host "Found existing tasks:" -ForegroundColor Yellow
    if ($ExistingShutdownTask) { Write-Host "  - $ShutdownTaskName" -ForegroundColor Yellow }
    if ($ExistingStartupTask) { Write-Host "  - $StartupTaskName" -ForegroundColor Yellow }
    
    $choice = Read-Host "Do you want to recreate them? (y/n)"
    if ($choice -ne "y" -and $choice -ne "Y") {
        Write-Host "Operation cancelled." -ForegroundColor Yellow
        Read-Host "Press Enter to exit"
        exit 0
    }
    
    # Remove existing tasks
    if ($ExistingShutdownTask) {
        Write-Host "Removing existing shutdown task..." -ForegroundColor Yellow
        Unregister-ScheduledTask -TaskName $ShutdownTaskName -Confirm:$false
    }
    if ($ExistingStartupTask) {
        Write-Host "Removing existing startup task..." -ForegroundColor Yellow
        Unregister-ScheduledTask -TaskName $StartupTaskName -Confirm:$false
    }
}

# Create tasks
$shutdownSuccess = Create-ShutdownTask
$startupSuccess = Create-StartupTask

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "         Setup Results" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green

if ($shutdownSuccess) {
    Write-Host "✓ Shutdown Task: $ShutdownTaskName" -ForegroundColor Green
    Write-Host "  - Executes: $ShutdownScriptPath" -ForegroundColor Cyan
    Write-Host "  - Trigger: System Shutdown" -ForegroundColor Cyan
} else {
    Write-Host "✗ Shutdown Task: Failed to create" -ForegroundColor Red
}

if ($startupSuccess) {
    Write-Host "✓ Startup Task: $StartupTaskName" -ForegroundColor Green
    Write-Host "  - Executes: $StartupScriptPath" -ForegroundColor Cyan
    Write-Host "  - Trigger: System Startup" -ForegroundColor Cyan
} else {
    Write-Host "✗ Startup Task: Failed to create" -ForegroundColor Red
}

Write-Host ""
Write-Host "Note: Shutdown task will run when system shuts down." -ForegroundColor Yellow
Write-Host "Note: Startup task will run when system starts up." -ForegroundColor Yellow
Write-Host ""

Read-Host "Press Enter to exit"
