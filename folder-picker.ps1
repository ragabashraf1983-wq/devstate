param([Parameter(Mandatory = $true)][string]$ResultFile)

$selected = ""
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $owner = New-Object System.Windows.Forms.Form
  $owner.Text = "Devstate - Choose Repository"
  $owner.StartPosition = "CenterScreen"
  $owner.Size = New-Object System.Drawing.Size(360, 120)
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $true
  $owner.Opacity = 0
  $owner.Show()
  $owner.Activate()

  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = "Choose a repository folder"
  $dialog.ShowNewFolderButton = $false
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    $selected = $dialog.SelectedPath
  }
} finally {
  [System.IO.File]::WriteAllText($ResultFile, $selected)
  if ($owner) { $owner.Close(); $owner.Dispose() }
}
