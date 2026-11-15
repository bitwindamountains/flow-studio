param([int]$Port = 8797)

$ErrorActionPreference = 'Stop'

function Confirm-StudioRestart {
    Add-Type -AssemblyName System.Windows.Forms
    $answer = [System.Windows.Forms.MessageBox]::Show(
        "Flow Studio is already running. Opening another window can leave it unable to approve credits.`n`nRestart Studio to open a fresh owner window? This closes its embedded agent and may interrupt generation or editing. Choose No if work is active.",
        'Restart Flow Studio?',
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button2
    )
    return $answer -eq [System.Windows.Forms.DialogResult]::Yes
}

function Get-StudioListener([int]$Port) {
    # Query failures must stop startup, rather than silently reusing an occupied port.
    return @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Port })
}

function Ensure-StudioPortFree([int]$Port, [string]$StudioScript) {
    $listeners = @(Get-StudioListener $Port)
    if (!$listeners.Count) { return }
    $owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -ne 1) { throw "Port $Port has multiple listeners. No processes were stopped." }
    $serverId = $owners[0]
    $server = Get-CimInstance Win32_Process -Filter "ProcessId = $serverId"
    # Support the old launcher's relative command as well as the new absolute script path.
    $scriptPattern = '(?:"' + [regex]::Escape($StudioScript) + '"|' + [regex]::Escape($StudioScript) + '|dist[\\/]studio\.js)'
    $nodePattern = '^(?:node(?:\.exe)?|"[^"\r\n]*[\\/]node\.exe"|[^\s"]*[\\/]node\.exe)\s+' + $scriptPattern + '\s*$'
    if ($server.Name -ne 'node.exe' -or $server.CommandLine -notmatch $nodePattern) {
        throw "Port $Port belongs to another process. No processes were stopped. Close it before starting Flow Studio."
    }
    if (!(Confirm-StudioRestart)) { throw 'Startup cancelled. The existing Studio was left running.' }
    # Recheck after the owner dialog: do not stop a replacement process.
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $serverId"
    if (!$current -or $current.CommandLine -ne $server.CommandLine -or $current.CreationDate -ne $server.CreationDate) {
        throw 'The listener changed while confirming. Run Flow Studio.cmd again.'
    }
    Stop-Process -Id $serverId -ErrorAction Stop
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        if (!(Get-StudioListener $Port).Count) { return }
        Start-Sleep -Milliseconds 100
    }
    throw "Port $Port did not close. No new Studio was started."
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Ensure-StudioPortFree -Port $Port -StudioScript (Join-Path (Split-Path $PSScriptRoot -Parent) 'engine\dist\studio.js')
    } catch {
        Write-Host $_.Exception.Message -ForegroundColor Red
        exit 1
    }
}
