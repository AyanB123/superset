# Superset CLI installer (Windows)
#
# Usage:
#   powershell -c "irm https://superset.sh/cli/install.ps1 | iex"
#
# Installs the Superset CLI and host-service to %USERPROFILE%\superset\.
# Adds %USERPROFILE%\superset\bin to the user PATH via
# [Environment]::SetEnvironmentVariable("Path", ..., "User").
#
# This is a faithful PowerShell port of install.sh for Windows. macOS/Linux
# users should use install.sh instead:
#   curl -fsSL https://superset.sh/cli/install.sh | sh

# Fail fast on any error, uninitialized variable, or terminating cmdlet.
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

$Repo = "superset-sh/superset"
$InstallDir = if ($env:SUPERSET_HOME) { $env:SUPERSET_HOME } else { Join-Path $env:USERPROFILE "superset" }
$Tag = if ($env:SUPERSET_VERSION) { $env:SUPERSET_VERSION } else { "latest" }

function Write-Info([string]$msg) { Write-Host "==> $msg" -ForegroundColor Green }
function Write-Err([string]$msg) {
	Write-Host "error: $msg" -ForegroundColor Red
	exit 1
}

function Detect-Target {
	# Windows-only installer. The sh installer handles macOS/Linux; point
	# non-Windows callers at it rather than silently producing a broken install.
	if ($env:OS -ne "Windows_NT") {
		Write-Err "Unsupported OS: this installer targets Windows only. For macOS/Linux run: curl -fsSL https://superset.sh/cli/install.sh | sh"
	}

	# Only x64 is shipped today. arm64 Windows will fall through to the error
	# below once it exists in the wild; for now the build is x64-only.
	# Target name "win32-x64" matches Node's process.platform identifier and the
	# tarball build-dist.ts publishes (superset-win32-x64.tar.gz) + the CLI
	# update command's detectTarget() — keep all three in sync.
	$arch = $env:PROCESSOR_ARCHITECTURE
	if ($arch -eq "AMD64") {
		return "win32-x64"
	}
	Write-Err "Unsupported Windows architecture: $arch (only x64 is supported)"
}

function Download-Tarball([string]$target) {
	$tarball = "superset-$target.tar.gz"
	if ($Tag -eq "latest") {
		$url = "https://github.com/$Repo/releases/download/cli-latest/$tarball"
	} else {
		$url = "https://github.com/$Repo/releases/download/$Tag/$tarball"
	}

	Write-Info "Downloading $url"
	# Atomic-ish download: write to a temp file, surface a clear error on
	# failure. Invoke-WebRequest throws on non-2xx under Stop, so the catch
	# only fires on real network/HTTP problems.
	$tmp = [System.IO.Path]::GetTempFileName()
	try {
		Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
	} catch {
		Remove-Item -Force -ErrorAction SilentlyContinue $tmp
		Write-Err "Failed to download $url"
	}
	return $tmp
}

function Extract-Tarball([string]$tarball) {
	Write-Info "Extracting to $InstallDir"
	if (-not (Test-Path $InstallDir)) {
		New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
	}
	# Win10 1803+ ships bsdtar as `tar.exe` in System32, which handles
	# .tar.gz transparently with -xzf (overwrites by default, no prompt).
	# If it's missing (older builds, removed optional feature) we fail loudly
	# rather than silently skipping extract.
	if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
		Remove-Item -Force -ErrorAction SilentlyContinue $tarball
		Write-Err "tar.exe not found. Windows 10 1803+ ships it by default; install the 'WSL' / 'tar' optional feature or upgrade."
	}
	& tar -xzf $tarball -C $InstallDir
	if ($LASTEXITCODE -ne 0) {
		Remove-Item -Force -ErrorAction SilentlyContinue $tarball
		Write-Err "tar extraction failed with exit code $LASTEXITCODE"
	}
	Remove-Item -Force -ErrorAction SilentlyContinue $tarball
}

function Update-Path {
	$binDir = Join-Path $InstallDir "bin"

	# Read the persisted USER path (not the live process PATH, which mixes
	# Machine + User + session entries). SetEnvironmentVariable("Path", ...,
	# "User") is the durable, idempotent mutation.
	$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
	if ([string]::IsNullOrEmpty($userPath)) { $userPath = "" }
	$entries = $userPath.Split(";") | Where-Object { $_ -ne "" }

	if ($entries -contains $binDir) {
		Write-Info "$binDir is already in PATH"
		return
	}

	$newPath = if ($userPath -eq "") { $binDir } else { "$userPath;$binDir" }
	[Environment]::SetEnvironmentVariable("Path", $newPath, "User")
	Write-Info "Added $binDir to user PATH"
}

function Main {
	Write-Host "Installing Superset CLI" -ForegroundColor White

	$target = Detect-Target
	Write-Info "Platform: $target"

	$tarball = Download-Tarball $target
	Extract-Tarball $tarball

	# Verify the expected binaries exist. The tarball ships them ready to run
	# (superset.exe is the compiled binary; superset-host.cmd is the launcher
	# that shells out to ..\lib\node.exe ..\lib\host-service.js).
	$binExe = Join-Path $InstallDir (Join-Path "bin" "superset.exe")
	$binHost = Join-Path $InstallDir (Join-Path "bin" "superset-host.cmd")
	if (-not (Test-Path $binExe)) {
		Write-Err "Expected executable not found: $binExe"
	}
	if (-not (Test-Path $binHost)) {
		Write-Err "Expected launcher not found: $binHost"
	}

	Update-Path

	Write-Host ""
	Write-Host "Installed!" -ForegroundColor Green
	# New processes pick up the updated USER Path automatically; the current
	# shell does not, so tell the user to open a new terminal. (There is no
	# exec $SHELL equivalent on Windows.)
	Write-Host "Open a new terminal to load the updated PATH."
	Write-Host "Then run " -NoNewline
	Write-Host "superset auth login" -ForegroundColor White -NoNewline
	Write-Host " to get started."
}

Main
