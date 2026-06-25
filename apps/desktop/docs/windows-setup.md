# Windows Setup Guide (Beta)

How to build and run the Superset desktop app on Windows. This is a **beta** surface: the app boots, terminals spawn, and the CLI installs, but several agent-integration features are still macOS/Linux-only (see [Known gaps](#known-gaps-current-limitations)).

For the architecture decisions behind the Windows port, see [windows-port-architecture.md](./windows-port-architecture.md).

## Prerequisites

### Required

| Tool | Version / Notes |
|:-----|:----------------|
| **Bun** | v1.0+ — [bun.sh](https://bun.sh/). Install via PowerShell: `powershell -c "irm bun.sh/install.ps1 \| iex"`. |
| **Visual Studio Build Tools 2022** | **REQUIRED.** Install with the **Desktop development with C++** workload (MSVC v143 + Windows 11 SDK). `node-pty` and `native-keymap` ship only Node-ABI prebuilds (not Electron's), so `electron-builder install-app-deps` recompiles them against Electron's ABI via `node-gyp` during `bun install`. The cross-platform `postinstall` auto-patches these builds for the common Windows pitfalls (a repo path containing a space → node-gyp #65; missing Spectre-mitigated libs → MSB8040; native-keymap's V8-API deprecation) — see `scripts/patch-native-builds.ts`. The build will still fail without the C++ workload itself. |
| **Python 3.11+** | **REQUIRED.** Used by `node-gyp` to compile `node-pty` (and to rebuild `better-sqlite3` / `node-pty` / `native-keymap` against the Electron ABI). |
| **Git** | 2.20+ — [git-scm.com](https://git-scm.com/). |
| **GitHub CLI (`gh`)** | [cli.github.com](https://cli.github.com/). |

After installing the Build Tools and Python, tell `node-gyp` which Visual Studio to use (run once):

```powershell
npm config set msvs_version 2022
```

### Optional but recommended

| Tool | Why |
|:-----|:---|
| **Git for Windows** | Provides `bash.exe`, which the agent-shell resolver probes for first (see [Agent shell](#agent-shell)). Without it the agent falls back to PowerShell / `cmd.exe`, which can't run the agent's bash-style command syntax as smoothly. Install from [git-scm.com](https://git-scm.com/) (the "Git for Windows" bundle). |
| **Developer Mode** (Settings → For developers) **or** `git config --global core.symlinks true` | The repo ships `.claude/` and `.cursor/` as symlinks to `../.agents/`. These are **optional** — slash-command discovery falls back to `.agents/commands` directly, so the app works without symlink support. Enabling Developer Mode (or the git config) makes the symlinks resolve. |
| **PowerShell 7+ (`pwsh`)** | Preferred over Windows PowerShell for both the interactive terminal and the agent-shell ladder. [github.com/PowerShell/PowerShell](https://github.com/PowerShell/PowerShell). |
| **Docker**, **jq**, **Caddy** | Only needed if you also want to run the local web-app dev stack (`./.superset/setup.local.sh`). The desktop app itself does not require these. |

## First-run sequence

From a PowerShell or cmd shell in the repo root:

```powershell
# 1. Install dependencies. The postinstall script is cross-platform (.ts run via bun).
bun install
```

`bun install` triggers `electron-builder install-app-deps`, which is where the **Build Tools 2022 + Python** requirement bites: `node-pty` is compiled from source at this step. If this step fails, it is almost always a missing C++ workload or `msvs_version` not set.

```powershell
# 2. Sanity-check lint + types (CI treats Biome warnings as errors).
bun run lint
bun run typecheck
```

```powershell
# 3. Launch the desktop app in dev mode.
bun dev:desktop
```

The first launch spawns the host-service, which spawns the `pty-daemon`. The daemon listens on a named pipe (`\\.\pipe\superset-ptyd-<orgHash>`) rather than a Unix socket — see the [architecture doc](./windows-port-architecture.md) for why.

## Local Electric sync (live data) + HTTPS

`bun dev:desktop` runs the full local stack — API (:3001), the desktop app, the `electric-proxy` Worker (:9666), and Caddy (:3010, TLS front for the API). Live data sync (Electric SQL) flows `client → electric-proxy → docker Electric (:3100)`.

Two Windows specifics:

- **electric-proxy port.** The conventional port (8787) is usually inside a Windows Hyper-V/WSL reserved TCP range (see the [Troubleshooting](#troubleshooting) note). `.env` sets `WRANGLER_PORT=9666` + `NEXT_PUBLIC_ELECTRIC_URL=http://127.0.0.1:9666` (9666 is outside the reserved range). `apps/electric-proxy/dev.ts` also auto-falls-back to the next usable port and prints it if 9666 is taken. If the client shows no live data, confirm the port the proxy logged matches `NEXT_PUBLIC_ELECTRIC_URL`.
- **Caddy root certificate.** Caddy's auto-install of its local CA fails silently on Windows (it tries the Java `keytool`, never the Windows store — and never raises a UAC). Install the root into your user trust store (no admin/UAC) once, after Caddy has generated it on its first run:
  ```powershell
  powershell -NoProfile -Command "Import-Certificate -FilePath \"$env:APPDATA\Caddy\pki\authorities\local\root.crt\" -CertStoreLocation Cert:\CurrentUser\Root"
  ```
  Chromium/Electron trusts `CurrentUser\Root`, so `https://localhost:3010` then works without a UAC prompt (this is the `mkcert` approach).

## Agent shell

The coding agent runs commands in your workspace via a shell. On Windows the resolver (`@superset/shared/agent-shell`, `resolveAgentShell()`) probes in this order:

1. **Git Bash** — `where bash.exe`, then the known `C:\Program Files\Git\...\bash.exe` paths.
2. **PowerShell** — `pwsh` (7+) preferred, else `powershell.exe`.
3. **cmd.exe** — `%COMSPEC%`, else `cmd.exe`.

> **Note:** the interactive terminal you open in the app (the one *you* type into) resolves independently — it picks PowerShell / `cmd.exe` per your config. The resolver above only governs the *agent's* command-execution shell.

## Verifying it works (smoke checklist)

After `bun dev:desktop`:

1. **App boots** — the window opens, the workspaces sidebar renders.
2. **Terminal spawns** — open a workspace, create a terminal tab, confirm a PowerShell (or cmd) prompt appears and accepts input.
3. **Slash command runs** — in an agent session, run a slash command from `.agents/commands/` (e.g. a project command). It should be discovered and execute.
4. **`superset auth login`** — from a standalone CLI install, run `superset auth login` and confirm the OAuth loopback flow completes (it uses `clip` to copy the code on Windows).

If any of these fail, the most common causes are: Build Tools not installed (node-pty compile error at install time), or the host-service / pty-daemon failing to come up (check the logs the dev console prints on spawn).

## Known gaps (current limitations)

Be aware of these before relying on the Windows build. They are tracked as follow-up work, not blockers to booting the app.

- **a. Agent bootstrap hooks: Claude + Codex work on Windows; Cursor/Gemini/Copilot pending.** The notify hook (`notify.sh`) is bash and runs under Git Bash. Claude (`~/.claude/settings.json`) and Codex (`~/.codex/hooks.json`) hooks install on Windows via per-agent `*-notify.cmd` launchers (in `$SUPERSET_HOME_DIR/hooks`) that run `notify.sh` via Git Bash — Claude pipes JSON via stdin, Codex forwards it as argv (`%*`). An agent launched inside a Superset terminal inherits the `SUPERSET_*` env (terminal id, hook URL) from the terminal, so activity notifications fire. Requires Git for Windows (Git Bash). Cursor / Gemini / Copilot are not yet ported — skipped via `WINDOWS_SUPPORTED_AGENT_SETUP_TARGET_IDS`.
- **b. The agent's command-execution shell cannot be explicitly configured yet.** `createMastraCode` (in the external `mastracode` package) has no shell option. On `win32` the agent uses the system default shell. The resolver in `@superset/shared/agent-shell` exists and is correct, but it is not yet threaded into `createMastraCode()` (see the [architecture doc, D5](./windows-port-architecture.md#d5-shell-strategy)).
- **c. PTY-daemon seamless-upgrade (fd-handoff) is disabled on Windows.** Updating the daemon restarts sessions — the documented destructive fallback. POSIX-only primitives (`tty.ReadStream`, `stty`, negative-pgid adoption) don't translate to ConPTY HANDLEs, so `DaemonSupervisor.update()` routes to `forceRestart()` on win32. Your open terminals close when the daemon updates.
- **d. There is NO OS-level sandbox on any platform.** The `sandbox_access_request` prompt is **advisory consent only** — there is no seatbelt / landlock / bubblewrap / Job-Object / AppContainer isolation behind it on macOS, Linux, *or* Windows. This is a cross-platform limitation, not Windows-specific; see [architecture doc, D6](./windows-port-architecture.md#d6-no-os-sandbox).
- **e. Distributable CLI packaging (`bun run build` → `bundle:cli`, the standalone `superset` CLI exe) works on Windows.** Bun's JS-API `Bun.build({ target: "bun", compile })` reports success but writes no output file on Windows (a bun-on-Windows compile-mode gap). `cli-framework build` works around it by spawning the CLI form `bun build --compile` on win32 (with the commands barrel pre-generated to a real file, plugin-free) — verified to produce the ~113 MB `superset.exe` (1053 modules, runs). macOS/Linux keep the JS-API + virtual-module plugin path. Note: if Bun is installed via npm (`bun.cmd` shim) **and** the official installer (`~/.bun/bin/bun.exe`), the shim shadows the real binary; prefer the official installer (`apps/desktop/scripts/build-bundled-cli.ts` already prefers `~/.bun/bin`).

## Troubleshooting

- **`node-gyp` / `node-pty` build failure at `bun install`** → confirm "Desktop development with C++" workload is installed in VS Build Tools 2022, Python 3.11+ is on `PATH`, and `npm config get msvs_version` returns `2022`.
- **`electric-proxy` / `wrangler dev` crashes on Windows with `std::terminate()` / "Workers runtime failed to start"** → this is **not** a workerd bug. The default dev port (8787) usually falls inside a Windows **excluded TCP port range** reserved by Hyper-V / WSL2 / Docker. Confirm with `netsh int ipv4 show excludedportrange protocol=tcp` (e.g. `8183–8882`). Binding to an excluded port fails misleadingly — bun/node report `EADDRINUSE`, workerd throws an uncaught bind exception → `std::terminate`. The `electric-proxy` dev launcher (`apps/electric-proxy/dev.ts`) detects excluded ranges and in-use ports and automatically falls back to the next usable port, logging the chosen port (e.g. `Using 8883 instead`). Point your Electric client / Caddy `reverse_proxy` at that logged port, or set `WRANGLER_PORT` to a port you've confirmed is outside every excluded range.
- **Terminal tab opens but immediately dies / no prompt** → check the dev-console output from the pty-daemon spawn. The named pipe path and the daemon readiness log are printed there.
- **An agent "doesn't launch" (opens then immediately closes / no TUI)** → most often a **stale agent CLI version**, not a Superset bug. For example, Codex `0.139.x` shows an "Update available — press enter" nag whose default Enter action is **"1. Update now"**, so the agent runs `npm i -g @openai/codex` on itself and exits ("Please restart Codex") instead of opening its TUI. Update the agent (`npm i -g @openai/codex`) and relaunch — verified: Codex `0.142.2` opens straight into its TUI with `permissions: YOLO mode`. The builtin command (`codex --dangerously-bypass-approvals-and-sandbox`) is correct; only the version was the problem.
- **Slash commands not discovered** → this is independent of Windows; confirm `.agents/commands/` exists at the repo root. The `.claude/commands` symlink is optional.
