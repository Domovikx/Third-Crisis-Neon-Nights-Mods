#Requires -Version 5.1
<#
.SYNOPSIS
  Build the MVP release zip for the RU translation patch (no game writes).
.DESCRIPTION
  Reads files from this repo only and writes dist/NeonPatchTranslator-vX-ru.zip.
  Never touches the game folder: no copies to Managed/, no loader install.
  The zip embeds install.ps1 (generated from the template below) plus
  README-INSTALL.md. The player extracts the zip into the game folder
  (next to the game exe) and runs install.ps1 once.
  Fails loudly (non-zero exit) if any source file is missing.
  Source of truth for the live deploy flow: deploy.mts (npm run deploy).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\package_release.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\package_release.ps1 -Lang ru -Version 1.0
#>
param(
  [string]$Lang = "ru",
  [string]$Version = "1.0"
)

$ErrorActionPreference = 'Stop'
$REPO  = Split-Path -Parent $MyInvocation.MyCommand.Path
$DIST  = Join-Path $REPO 'dist'
$ZIP   = Join-Path $DIST ("NeonPatchTranslator-v" + $Version + "-" + $Lang + ".zip")
$STAGE = Join-Path $DIST 'stage'

function Step($msg) { Write-Host ("==> " + $msg) }

function Need-File($path, $hint) {
  if (-not (Test-Path $path)) { throw ("MISSING source file: " + $path + ". " + $hint) }
  if ((Get-Item $path).Length -le 0) { throw ("EMPTY source file: " + $path + ". " + $hint) }
  Step ("found: " + $path)
}

# --- 1. Check all sources (repo reads only) ---
Step 'Checking source files (repo only, game folder is not touched)'
$SRC_LOADER = Join-Path $REPO 'dwmapi.dll'
$SRC_DLL    = Join-Path $REPO 'runtime\NeonTranslatorRuntime.dll'
$SRC_DAT    = Join-Path $REPO ('runtime\patch_' + $Lang + '.dat')
$SRC_TTF    = Join-Path $REPO 'fonts\RobotoCondensed-Regular.ttf'
$SRC_README = Join-Path $REPO 'README-INSTALL.md'
Need-File $SRC_LOADER 'Rebuild the proxy (build_proxy.py) or restore the repo copy.'
Need-File $SRC_DLL 'Build the runtime (npm run build).'
Need-File $SRC_DAT ('Compile it first: npm run po2dat -- ' + $Lang + '. NOTE: runtime/*.dat is gitignored, a fresh clone does not have it.')
Need-File $SRC_TTF 'Restore fonts/RobotoCondensed-Regular.ttf.'
Need-File $SRC_README 'Restore README-INSTALL.md at the repo root.'

# --- 2. Stage the payload (dist writes only) ---
Step 'Staging payload'
if (Test-Path $STAGE) { Remove-Item $STAGE -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $STAGE 'runtime') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $STAGE 'fonts') | Out-Null
Copy-Item $SRC_LOADER $STAGE -Force
Copy-Item $SRC_DLL (Join-Path $STAGE 'runtime') -Force
Copy-Item $SRC_DAT (Join-Path $STAGE 'runtime') -Force
Copy-Item $SRC_TTF (Join-Path $STAGE 'fonts') -Force
Copy-Item $SRC_README $STAGE -Force

# --- 3. Generate install.ps1 from the embedded template ---
# NOTE: install.ps1 is intentionally NOT a repo file. It lives here as an
# ASCII-only template and materializes only inside dist/stage and the zip.
# Paths below are relative to the extracted location (= game root).
$InstallPs1 = @'
#Requires -Version 5.1
<#
.SYNOPSIS
  Install the RU translation patch into the game folder (idempotent).
.DESCRIPTION
  Run AFTER extracting the release zip into the game folder (the folder
  that contains the game exe). Copies the payload into
  "<game>/Third Crisis Neon Nights_Data/Managed/", writes active_lang.txt,
  and verifies every copy. Safe to re-run: all operations overwrite.
  The optional -GameDir override exists only for automated testing;
  players run this script from inside the game folder with no arguments.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
#>
param(
  [string]$GameDir = ""
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($GameDir)) { $GameDir = $PSScriptRoot }
$MANAGED = Join-Path $GameDir 'Third Crisis Neon Nights_Data\Managed'
$LANG = 'ru'

function Step($msg) { Write-Host ("==> " + $msg) }

function Need-File($path, $hint) {
  if (-not (Test-Path $path)) { throw ("MISSING: " + $path + ". " + $hint) }
  if ((Get-Item $path).Length -le 0) { throw ("EMPTY: " + $path + ". " + $hint) }
}

function Check-Copy($src, $dst) {
  if (-not (Test-Path $dst)) { throw ("VERIFY FAILED, not found: " + $dst) }
  $a = (Get-Item $src).Length
  $b = (Get-Item $dst).Length
  if ($a -ne $b) { throw ("VERIFY FAILED, size mismatch: " + $dst + " (" + $b + " != " + $a + ")") }
  Step ("OK: " + $dst)
}

Step ("Game dir: " + $GameDir)
if (-not (Test-Path $MANAGED)) { throw ("Managed dir not found: " + $MANAGED + ". Extract the FULL zip into the game folder (next to the game exe) and rerun.") }

Need-File (Join-Path $GameDir 'dwmapi.dll') 'Extract the FULL zip into the game folder (dwmapi.dll must sit next to install.ps1).'
$SRC_DLL = Join-Path $GameDir 'runtime\NeonTranslatorRuntime.dll'
$SRC_DAT = Join-Path $GameDir ('runtime\patch_' + $LANG + '.dat')
$SRC_TTF = Join-Path $GameDir 'fonts\RobotoCondensed-Regular.ttf'
Need-File $SRC_DLL 'Extract the FULL zip into the game folder (runtime/ is missing).'
Need-File $SRC_DAT 'Extract the FULL zip into the game folder (runtime/ is missing).'
Need-File $SRC_TTF 'Extract the FULL zip into the game folder (fonts/ is missing).'

Step 'Copying DLL + dictionary + font to Managed/'
Copy-Item $SRC_DLL $MANAGED -Force
Copy-Item $SRC_DAT $MANAGED -Force
Copy-Item $SRC_TTF $MANAGED -Force
Set-Content -Path (Join-Path $MANAGED 'active_lang.txt') -Value $LANG -NoNewline

Step 'Verifying copies'
Check-Copy $SRC_DLL (Join-Path $MANAGED 'NeonTranslatorRuntime.dll')
Check-Copy $SRC_DAT (Join-Path $MANAGED ('patch_' + $LANG + '.dat'))
Check-Copy $SRC_TTF (Join-Path $MANAGED 'RobotoCondensed-Regular.ttf')
$actual = (Get-Content -Path (Join-Path $MANAGED 'active_lang.txt') -Raw)
if ($actual -ne $LANG) { throw ("VERIFY FAILED: active_lang.txt contains '" + $actual + "', expected '" + $LANG + "'") }
Step 'OK: active_lang.txt'
if (-not (Test-Path (Join-Path $GameDir 'dwmapi.dll'))) { throw 'VERIFY FAILED: dwmapi.dll is missing next to the game exe.' }
Step 'OK: dwmapi.dll next to the game exe'

Write-Host ''
Write-Host 'Done. Restart the game, then check: <game>\Third Crisis Neon Nights_Data\Managed\NeonTranslator.log'
Write-Host ('It should contain lines "Lang: ' + $LANG + ' ..." and "Translations: <number>".')
Write-Host ''
Write-Host 'NOTE: Steam "Verify integrity of game files" deletes dwmapi.dll'
Write-Host '(it is not part of the game). The Managed/ files stay, but the'
Write-Host 'translation will stop loading. Fix: just re-run this install.ps1.'
'@
$utf8NoBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $STAGE 'install.ps1'), $InstallPs1.Replace("`r`n", "`n"), $utf8NoBom)
Step 'generated: install.ps1'

# --- 4. Zip it ---
Step 'Creating zip'
if (-not (Test-Path $DIST)) { New-Item -ItemType Directory -Path $DIST | Out-Null }
if (Test-Path $ZIP) { Remove-Item $ZIP -Force }
Compress-Archive -Path (Join-Path $STAGE '*') -DestinationPath $ZIP -Force
if (-not (Test-Path $ZIP)) { throw ('ZIP was not created: ' + $ZIP) }
if ((Get-Item $ZIP).Length -le 0) { throw ('ZIP is empty: ' + $ZIP) }

# --- 5. Verify zip contents ---
Step 'Verifying zip contents'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipRead = [IO.Compression.ZipFile]::OpenRead($ZIP)
try {
  $names = @($zipRead.Entries | ForEach-Object { $_.FullName.Replace('\', '/') } | Where-Object { -not $_.EndsWith('/') })
} finally { $zipRead.Dispose() }
$expected = @(
  'dwmapi.dll',
  'install.ps1',
  'README-INSTALL.md',
  'runtime/NeonTranslatorRuntime.dll',
  ('runtime/patch_' + $Lang + '.dat'),
  'fonts/RobotoCondensed-Regular.ttf'
)
foreach ($e in $expected) {
  if ($names -notcontains $e) { throw ('ZIP VERIFY FAILED, missing entry: ' + $e) }
}
if ($names.Count -ne $expected.Count) { throw ('ZIP VERIFY FAILED, unexpected entries: ' + ($names -join ', ')) }
foreach ($n in $names) { Step ('zip entry: ' + $n) }

Remove-Item $STAGE -Recurse -Force
$kb = [math]::Round((Get-Item $ZIP).Length / 1KB)
Step ("OK: " + $ZIP + " (" + $kb + " KB, " + $names.Count + " files)")
Write-Host 'Game folder was NOT touched (repo reads + dist writes only).'
Write-Host 'Next: extract the zip into the game folder and run install.ps1 there.'
