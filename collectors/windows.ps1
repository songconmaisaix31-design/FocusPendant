<#
.SYNOPSIS
Sample the Windows foreground app and idle time for FocusPendant.
.DESCRIPTION
Run in Windows PowerShell (not inside WSL). No installation or auto-start.
Window titles are omitted unless -IncludeTitles is explicitly supplied.
Stop with Ctrl+C. Requires an already running FocusPendant server.
.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\collectors\windows.ps1
.EXAMPLE
$env:FOCUS_SERVER_URL = 'http://127.0.0.1:7788'
$env:FOCUS_TOKEN = 'your-local-server-token'
.\collectors\windows.ps1 -IncludeTitles -IntervalSeconds 5
#>
[CmdletBinding()]
param(
    [string]$ServerUrl = $(if ($env:FOCUS_SERVER_URL) { $env:FOCUS_SERVER_URL } else { 'http://127.0.0.1:7788' }),
    [ValidateRange(1, 300)][int]$IntervalSeconds = 5,
    [switch]$IncludeTitles,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this collector in Windows PowerShell, outside WSL.' }
$endpoint = $null
if (-not [Uri]::TryCreate(($ServerUrl.TrimEnd('/') + '/events'), [UriKind]::Absolute, [ref]$endpoint) -or
    $endpoint.Scheme -notin @('http', 'https')) { throw 'ServerUrl must be an http:// or https:// URL.' }

if (-not ('FocusPendantNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FocusPendantNative {
    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr window, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("kernel32.dll")] private static extern uint GetTickCount();
    public static double IdleSeconds() {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (!GetLastInputInfo(ref info)) throw new InvalidOperationException("Cannot read idle time");
        return unchecked(GetTickCount() - info.dwTime) / 1000.0;
    }
}
'@
}

$sessionSalt = [Guid]::NewGuid().ToString('N')
$hasher = [Security.Cryptography.SHA256]::Create()
$headers = @{}
if ($env:FOCUS_TOKEN) { $headers['Authorization'] = 'Bearer ' + $env:FOCUS_TOKEN }
$hadError = $false
Write-Host ('FocusPendant window collector started; titles: ' + [bool]$IncludeTitles + '. Ctrl+C stops collection.')

try {
    do {
        try {
            $windowHandle = [FocusPendantNative]::GetForegroundWindow()
            if ($windowHandle -eq [IntPtr]::Zero) {
                # A locked desktop or a missing foreground window is not an activity sample.
                if ($Once) { throw 'No foreground window is available.' }
                Start-Sleep -Seconds $IntervalSeconds
                continue
            }
            [uint32]$foregroundProcessId = 0
            $null = [FocusPendantNative]::GetWindowThreadProcessId($windowHandle, [ref]$foregroundProcessId)
            $appName = 'unknown'
            try { $appName = [Diagnostics.Process]::GetProcessById([int]$foregroundProcessId).ProcessName } catch { }
            $digest = $hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($sessionSalt + ':' + $windowHandle.ToInt64()))
            $windowKey = ([BitConverter]::ToString($digest) -replace '-', '').Substring(0, 16).ToLowerInvariant()
            $sample = @{
                type = 'window'
                ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                app = $appName
                windowId = $windowKey
                idle_sec = [Math]::Round([FocusPendantNative]::IdleSeconds(), 1)
            }
            if ($IncludeTitles) {
                $titleBuffer = New-Object Text.StringBuilder 512
                $null = [FocusPendantNative]::GetWindowText($windowHandle, $titleBuffer, $titleBuffer.Capacity)
                $sample['title'] = $titleBuffer.ToString()
            }
            $body = [Text.Encoding]::UTF8.GetBytes(($sample | ConvertTo-Json -Compress))
            $null = Invoke-RestMethod -Uri $endpoint -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 5
            if ($hadError) { Write-Host 'Collector connection restored.'; $hadError = $false }
        } catch {
            if ($Once) { throw }
            if (-not $hadError) { Write-Warning 'Could not collect or deliver activity. Check that the local server is running; retrying.' }
            $hadError = $true
        }
        if (-not $Once) { Start-Sleep -Seconds $IntervalSeconds }
    } while (-not $Once)
} finally {
    $hasher.Dispose()
    Write-Host 'FocusPendant window collector stopped.'
}
