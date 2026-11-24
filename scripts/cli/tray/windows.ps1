# Cartethyia tray icon for Windows using NotifyIcon.
#
# Why PowerShell instead of a Node tray library: `systray2` and friends bundle a
# helper binary and still leave the spawning process attached to a console, so
# Windows Terminal shows an empty tab for the tray's whole lifetime. A
# PowerShell NotifyIcon owns no console of its own when started with
# -WindowStyle Hidden, and the protocol here is plain JSON lines on
# stdin/stdout, so the parent stays in charge.
#
# Protocol: the parent writes one JSON object per line.
#   {"action":"add-item","index":0,"title":"...","enabled":true}
#   {"action":"update-item","index":0,"title":"...","enabled":true}
#   {"action":"set-tooltip","text":"..."}
#   {"action":"hide"} {"action":"show"}
#   {"action":"kill"}
# This script writes one JSON object per line:
#   {"type":"started"} {"type":"ready"} {"type":"click","index":0}
#   {"type":"hidden"} {"type":"shown"}
#
# hide/show only toggle NotifyIcon.Visible. The helper, its menu and its
# message loop keep running, because the tray process owns the gateway's only
# interactive surface: ending the helper to hide the icon would end the tray.
#
# -StartHidden creates the icon already hidden. It exists so a tray that was
# hidden last time comes back hidden without drawing the icon even once: showing
# it first and hiding it after would flash on every start.
param([string]$IconPath, [string]$Tooltip, [switch]$StartHidden)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

$script:notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$script:notifyIcon.Icon = New-Object System.Drawing.Icon($IconPath)
$script:notifyIcon.Text = $Tooltip
# Unset means visible: the switch is only ever passed to reproduce a hidden
# start, and a missing argument must not hide every icon.
$script:notifyIcon.Visible = -not $StartHidden

$script:menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:notifyIcon.ContextMenuStrip = $script:menu
$script:items = @()

function Write-Event($obj) {
  $json = $obj | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Add-MenuItem($index, $title, $enabled) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem
  $item.Text = $title
  $item.Enabled = $enabled
  $idx = $index
  $item.Add_Click({ Write-Event @{ type = "click"; index = $idx } }.GetNewClosure())
  $script:menu.Items.Add($item) | Out-Null
  $script:items += $item
}

# A real ToolStripSeparator draws the divider. Sending a "-" title instead
# renders a literal dash row, which is what the menu showed before.
function Add-MenuSeparator($index) {
  $item = New-Object System.Windows.Forms.ToolStripSeparator
  $script:menu.Items.Add($item) | Out-Null
  $script:items += $item
}

function Update-MenuItem($index, $title, $enabled) {
  if ($index -lt $script:items.Count) {
    $script:items[$index].Text = $title
    $script:items[$index].Enabled = $enabled
  }
}

function Set-Tooltip($text) {
  # NotifyIcon.Text is capped at 63 characters.
  if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
  $script:notifyIcon.Text = $text
}

# Stdin is polled from the UI thread: a background thread reading Console.In
# races the message loop and deadlocks when the menu is open.
$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 100
$script:timer.Add_Tick({
  try {
    while ([Console]::In.Peek() -ne -1) {
      $line = [Console]::In.ReadLine()
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      $cmd = $line | ConvertFrom-Json
      switch ($cmd.action) {
        "add-item"    { Add-MenuItem $cmd.index $cmd.title $cmd.enabled }
        "add-separator" { Add-MenuSeparator $cmd.index }
        "update-item" { Update-MenuItem $cmd.index $cmd.title $cmd.enabled }
        "set-tooltip" { Set-Tooltip $cmd.text }
        "hide"        {
          $script:notifyIcon.Visible = $false
          Write-Event @{ type = "hidden" }
        }
        "show"        {
          $script:notifyIcon.Visible = $true
          Write-Event @{ type = "shown" }
        }
        "ready"       { Write-Event @{ type = "ready" } }
        "kill"        {
          $script:notifyIcon.Visible = $false
          $script:notifyIcon.Dispose()
          [System.Windows.Forms.Application]::Exit()
        }
      }
    }
  } catch {
    Write-Event @{ type = "error"; message = $_.Exception.Message }
  }
})
$script:timer.Start()

Write-Event @{ type = "started" }
[System.Windows.Forms.Application]::Run()
