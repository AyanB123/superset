# Smoke-tests a built CLI distribution (Windows port of smoke-test.sh).
#
# Usage: .\smoke-test.ps1 -Dist <dist-dir>
#   <dist-dir>  extracted distribution root (contains bin\, lib\, share\)
#
# The decisive check is "boot the host service": a missing or unshippable
# module (@mastra/core, @xterm/headless, anything reached via createRequire)
# crashes the boot, so reaching a healthy listening state proves the whole
# host-service module graph is satisfiable. The require() probes above it
# only load individual native addons — they never load host-service.js.
#
# PowerShell semantics mirror smoke-test.sh: same probes, same exit codes
# (non-zero on any failure), same isolation (throwaway org/token/secret/
# sqlite DB, no RELAY_URL/tunnel). The only Windows-specific differences:
#   - PTY spawn asserts cmd.exe (vs /bin/sh) — powershell.exe also works.
#   - The host wrapper is bin\superset-host.cmd, which invokes
#     ..\lib\node.exe ..\lib\host-service.js (vs the posix bin/superset-host).
#   - Cleanup uses Stop-Process instead of kill/pkill.
[CmdletBinding()]
param(
	[Parameter(Mandatory = $true, Position = 0)]
	[string]$Dist
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

if (-not (Test-Path -LiteralPath $Dist)) {
	Write-Error "[smoke] dist dir not found: $Dist"
	exit 1
}
$Dist = (Get-Item -LiteralPath $Dist).FullName
Write-Host "[smoke] dist=$Dist target=win32-x64"

# ---------------------------------------------------------------------------
# Sanity: CLI binary + bundled Node + host/pty bundles present.
# ---------------------------------------------------------------------------
$cliBin = Join-Path $Dist "bin\superset.exe"
$nodeExe = Join-Path $Dist "lib\node.exe"
$hostJs = Join-Path $Dist "lib\host-service.js"
$ptyJs = Join-Path $Dist "lib\pty-daemon.js"

& $cliBin --version
& $cliBin --help | Select-Object -First 5
& $nodeExe --version
if (-not (Test-Path -LiteralPath $hostJs)) { Write-Error "[smoke] missing host-service.js"; exit 1 }
if (-not (Test-Path -LiteralPath $ptyJs)) { Write-Error "[smoke] missing pty-daemon.js"; exit 1 }

# ---------------------------------------------------------------------------
# Native addon require() probes + a real PTY spawn. Run from a temp dir so
# Node's module resolution doesn't walk up into a host repo's node_modules
# and shadow the bundle. NODE_PATH points at the bundled node_modules.
# ---------------------------------------------------------------------------
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "superset-smoke"
if (Test-Path $tempRoot) { Remove-Item -Recurse -Force $tempRoot }
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

# 1) require() each native addon. $nodeModulesLib is the bundled node_modules
#    that host-service resolves its peers from.
$nodeModulesLib = Join-Path $Dist "lib\node_modules"
$env:NODE_PATH = $nodeModulesLib
try {
	$probeScript = @'
const mods = ["better-sqlite3", "node-pty", "@parcel/watcher", "libsql"];
for (const m of mods) {
	require(m);
	console.log("[smoke]", m, "OK");
}
'@
	# Push-Location so node's cwd is the temp dir; the -e script relies on
	# NODE_PATH (set above), not on a local node_modules.
	Push-Location $tempRoot
	try {
		& $nodeExe -e $probeScript
	} finally {
		Pop-Location
	}
	if ($LASTEXITCODE -ne 0) {
		Write-Error "[smoke] native addon require() probe failed"
		exit 1
	}

	# 2) node-pty must resolve from the bundled tree (not a leaked host copy),
	#    and a real PTY spawn must succeed. On Windows we spawn cmd.exe
	#    instead of /bin/sh; the assertion is identical otherwise.
	$ptyScript = @'
const DIST = process.env.SMOKE_DIST;
const resolved = require.resolve("node-pty/lib/windowsPtyAgent");
if (!resolved.toLowerCase().startsWith(DIST.toLowerCase())) {
	console.error("[smoke] node-pty leaked from non-bundled tree:", resolved);
	process.exit(1);
}
const pty = require("node-pty");
// cmd.exe echoes the command by default under a pty; /c runs the command
// and the PTY captures its stdout (echo SPAWN_OK).
const term = pty.spawn("cmd.exe", ["/c", "echo SPAWN_OK"], {
	name: "xterm", cols: 80, rows: 24,
	cwd: process.cwd(), env: process.env,
});
let got = "";
let exited = null;
const check = () => {
	if (got.includes("SPAWN_OK") && exited && exited.exitCode === 0) {
		console.log("[smoke] pty spawn OK"); process.exit(0);
	}
	console.error("[smoke] pty spawn FAIL exit=" + (exited && exited.exitCode) + " got=" + JSON.stringify(got));
	process.exit(1);
};
term.onData((d) => { got += d.toString(); });
term.onExit((e) => { exited = e; setTimeout(check, 100); });
setTimeout(() => { console.error("[smoke] pty spawn timeout"); process.exit(1); }, 5000);
'@
	$env:SMOKE_DIST = $Dist
	Push-Location $tempRoot
	try {
		& $nodeExe -e $ptyScript
		$ptyExit = $LASTEXITCODE
	} finally {
		Pop-Location
		Remove-Item Env:\SMOKE_DIST -ErrorAction SilentlyContinue
	}
	if ($ptyExit -ne 0) {
		Write-Error "[smoke] pty spawn probe failed"
		exit 1
	}
} finally {
	Remove-Item Env:\NODE_PATH -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# Boot the host service. RELAY_URL is omitted (no tunnel); a throwaway org,
# token, secret and sqlite DB keep it fully isolated. Reaching health.check
# means host-service.js and its entire module graph loaded.
# ---------------------------------------------------------------------------
Write-Host "[smoke] booting host service"

$hsDir = Join-Path $tempRoot "host"
New-Item -ItemType Directory -Force -Path $hsDir | Out-Null

# Pick a free TCP port on 127.0.0.1 by binding and immediately closing a
# TcpListener — same trick the sh script uses via node's net.createServer.
$portScript = @'
const s = require("net").createServer();
s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });
'@
$hsPort = (& $nodeExe -e $portScript).Trim()

$hsOrg = "00000000-0000-4000-8000-0000000000aa"
# bin\superset-host.cmd is the launcher that calls lib\node.exe lib\host-service.js.
$hostLauncher = Join-Path $Dist "bin\superset-host.cmd"
$hostLog = Join-Path $hsDir "host.log"
if (Test-Path -LiteralPath $hostLog) { Remove-Item -Force -LiteralPath $hostLog }

# Build an isolated environment for the host process. Copy the current
# process PATH (so cmd.exe + node.exe resolve) and override the rest.
$hsEnv = @{}
$hsEnv["PATH"] = $env:PATH
$hsEnv["ORGANIZATION_ID"] = $hsOrg
$hsEnv["AUTH_TOKEN"] = "smoke-test-token"
$hsEnv["SUPERSET_API_URL"] = "https://api.superset.sh"
$hsEnv["PORT"] = $hsPort
$hsEnv["HOST_SERVICE_PORT"] = $hsPort
$hsEnv["HOST_SERVICE_SECRET"] = "smoke-test-secret"
$hsEnv["HOST_DB_PATH"] = (Join-Path $hsDir "host.db")
$hsEnv["HOST_MIGRATIONS_FOLDER"] = (Join-Path $Dist "share\migrations")

# Start the host detached and capture stdout+stderr to host.log.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $hostLauncher
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
foreach ($kv in $hsEnv.GetEnumerator()) {
	$psi.EnvironmentVariables[$kv.Key] = $kv.Value
}
$hsProcess = [System.Diagnostics.Process]::Start($psi)
$script:hsProcess = $hsProcess
$script:hostLog = $hostLog

# Drain output to the log file so the pipe buffer can't fill and deadlock
# the process before it reaches a listening state. Register-ObjectEvent
# handlers run in this runspace and resolve $script:hostLog directly.
$null = Register-ObjectEvent -InputObject $hsProcess -EventName "OutputDataReceived" -Action {
	param($s, $e)
	if ($e.Data) { Add-Content -LiteralPath $script:hostLog -Value $e.Data }
}
$null = Register-ObjectEvent -InputObject $hsProcess -EventName "ErrorDataReceived" -Action {
	param($s, $e)
	if ($e.Data) { Add-Content -LiteralPath $script:hostLog -Value $e.Data }
}
$hsProcess.EnableRaisingEvents = $true
$hsProcess.BeginOutputReadLine()
$hsProcess.BeginErrorReadLine()

function Stop-HostTree {
	if ($null -ne $script:hsProcess -and -not $script:hsProcess.HasExited) {
		try { Stop-Process -Id $script:hsProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
	}
	# Kill any lingering pty-daemon spawned from this dist. Match on the
	# pty-daemon.js path under our dist to avoid nuking unrelated processes.
	try {
		Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
			Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$Dist*") } |
			ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
	} catch {}
}

$healthy = $false
for ($i = 0; $i -lt 120; $i++) {
	if ($hsProcess.HasExited) { break }
	try {
		$resp = Invoke-WebRequest -Uri "http://127.0.0.1:$hsPort/trpc/health.check" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
		if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) {
			$healthy = $true
			break
		}
	} catch {
		# Not up yet (connection refused / timeout). Loop and retry.
	}
	Start-Sleep -Milliseconds 500
}

if (-not $healthy) {
	Stop-HostTree
	Write-Error "[smoke] FAIL - host service never reached a healthy listening state"
	Write-Error "----- host.log -----"
	if (Test-Path -LiteralPath $hostLog) {
		Get-Content -LiteralPath $hostLog | ForEach-Object { Write-Error $_ }
	}
	exit 1
}

Write-Host "[smoke] host service boot OK"
Stop-HostTree
Write-Host "[smoke] all checks passed"
