#Requires -Version 5.1
<#
.SYNOPSIS
  Deploy NeonTranslator patch into the game folder (no YAML involved).
.DESCRIPTION
  Bridge between the patch repo (NeonTranslator/) and the game root:
    - runtime/NeonTranslatorRuntime.dll -> <game>/Third Crisis Neon Nights_Data/Managed/
    - fonts/RobotoCondensed-Regular.ttf -> <game>/Third Crisis Neon Nights_Data/Managed/
    - runtime/patch_<lang>.dat (built from po/<lang>.po) -> Managed/
    - active_lang.txt -> Managed/ (tells the runtime which patch_*.dat to load)
    - dwmapi.dll (proxy loader) -> <game>/dwmapi.dll (must sit next to the exe)
    - removes legacy <game>/translations/ YAML mirror if present
  Switches:
    -Lang    language code (default ru; de/es/pt/pl drafted next)
    -Rebuild rebuild C# runtime (and proxy if -Proxy) before deploying
    -Proxy   also rebuild dwmapi.dll via build_proxy.py (needs MSVC; resyncs repo copy)
  NOTE: Steam "verify integrity" removes dwmapi.dll from game root -> just rerun this script.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\deploy.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Lang de -Rebuild
#>
param(
  [string]$Lang = "ru",
  [switch]$Rebuild,
  [switch]$Proxy
)

$ErrorActionPreference = 'Stop'
$PATCH_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$GAME_DIR  = Split-Path -Parent $PATCH_DIR
$MANAGED   = Join-Path $GAME_DIR 'Third Crisis Neon Nights_Data\Managed'

function Step($msg) { Write-Host "==> $msg" }

if ($Rebuild) {
  Step 'Building NeonTranslatorRuntime.dll'
  python (Join-Path $PATCH_DIR '.opencode\skills\build-translator\scripts\build.py')
  if ($LASTEXITCODE -ne 0) { throw 'build.py failed' }
  if ($Proxy) {
    Step 'Building dwmapi.dll proxy'
    python (Join-Path $PATCH_DIR '.opencode\skills\build-translator\scripts\build_proxy.py')
    if ($LASTEXITCODE -ne 0) { throw 'build_proxy.py failed' }
    Copy-Item (Join-Path $GAME_DIR 'dwmapi.dll') (Join-Path $PATCH_DIR 'dwmapi.dll') -Force
    Step 'Repo copy of dwmapi.dll resynced'
  }
}

if (-not (Test-Path $MANAGED)) { throw "Managed dir not found: $MANAGED" }

Step "Compiling po/$Lang.po -> patch_$Lang.dat"
if ($Lang -eq "en") {
  Step 'Lang en: native English, no dictionary build (skipping po2dat.py)'
} else {
  python (Join-Path $PATCH_DIR ".opencode\skills\extract-text\scripts\po2dat.py") $Lang
  if ($LASTEXITCODE -ne 0) { throw 'po2dat.py failed' }
}

Step 'Deploying DLL + font + dictionary to Managed/'
Copy-Item (Join-Path $PATCH_DIR 'runtime\NeonTranslatorRuntime.dll') $MANAGED -Force
Copy-Item (Join-Path $PATCH_DIR 'fonts\RobotoCondensed-Regular.ttf') $MANAGED -Force
foreach ($ttf in @('NotoSansSC.ttf', 'NotoSansJP.ttf')) {
  $src = Join-Path $PATCH_DIR "fonts\$ttf"
  if (Test-Path $src) { Copy-Item $src $MANAGED -Force }
}
if ($Lang -eq "en") {
  Remove-Item (Join-Path $MANAGED "patch_en.dat") -ErrorAction SilentlyContinue
} else {
  Copy-Item (Join-Path $PATCH_DIR "runtime\patch_$Lang.dat") $MANAGED -Force
}
Set-Content -Path (Join-Path $MANAGED 'active_lang.txt') -Value $Lang -NoNewline

Step 'Removing legacy game-root translations/ YAML mirror'
$DEST_TR = Join-Path $GAME_DIR 'translations'
if (Test-Path $DEST_TR) { Remove-Item $DEST_TR -Recurse -Force }

Step 'Installing dwmapi.dll loader next to the exe'
Copy-Item (Join-Path $PATCH_DIR 'dwmapi.dll') (Join-Path $GAME_DIR 'dwmapi.dll') -Force

if ($Lang -eq "en") {
  Step 'Done: lang=en (native English, no patch dat), DLL+font+active_lang.txt in Managed/, loader in game root.'
} else {
  Step "Done: lang=$Lang, DLL+font+patch_$Lang.dat+active_lang.txt in Managed/, loader in game root."
}
Write-Host 'Restart the game, then check: <game>\Third Crisis Neon Nights_Data\Managed\NeonTranslator.log'
