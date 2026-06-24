# Windows Port — Architecture Decisions

Record of the key architecture decisions for native Windows support. Full background and the wave-by-wave implementation plan live in [`plans/windows-native-support.md`](../../../plans/windows-native-support.md). For the developer-facing setup guide, see [windows-setup.md](./windows-setup.md).

Each decision below is written as **Context → Decision → Consequences**. The guiding constraint across all of them: **zero behavior change on macOS/Linux** — every Windows branch is additive and platform-gated.

---

## D1: Shape — inline platform branching, not a shared platform-interface module

### Context
Superset is Electron + node-pty + better-sqlite3, all of which ship native Windows support (ConPTY, prebuilt `.node` binaries). The codebase was already ~70% cross-platform before the port: scattered, working `process.platform === "win32"` branches existed in `DaemonSupervisor` (pty-daemon spawn), `host-info` (machine-id via `reg query`), `bundled-cli.ts` (`.cmd` shim), `electron-builder.ts` (NSIS win target), and `user-shell.ts` (COMSPEC resolver). A heavy interface-refactor (a fresh port with a `Platform` abstraction layer) would touch every one of those working sites.

### Decision
Use **inline platform branching at natural sites** (the same `process.platform === "win32"` pattern already in use), not a shared platform-interface module. Node's `net` module already abstracts named pipes behind the same `{ path }` option on both platforms, and `node-pty` already abstracts ConPTY. New cross-cutting helpers (e.g. `killProcessTree`, `ptySocketPath`) live in `packages/shared/src/platform/`, but existing working branches are left untouched — no risky refactor-in.

### Consequences
- **+** Matches existing convention; no churn in working macOS/Linux code paths.
- **+** `node-pty` / `net` already absorb the hardest parts, so most branches are small.
- **−** Platform logic is spread across files rather than centralized; a future port (e.g. remote runners) may still want an interface. Accepted for now — "complete POSIX-only paths" outranks "perfect abstraction."

---

## D2: PTY daemon — ConPTY + fresh-spawn; seamless-upgrade disabled on Windows

### Context
On POSIX, the pty-daemon can hand open PTY file descriptors to a new daemon process during an upgrade (`AdoptedPty` / `prepareUpgrade` / `adoptSnapshot`), using `tty.ReadStream`, `stty`, and negative-pgid process-group adoption. This lets users keep their terminals across a daemon update. Windows uses ConPTY (via node-pty native), whose pseudoconsole HANDLEs are **not inheritable file descriptors** — the POSIX fd-handoff machinery has no Windows equivalent.

### Decision
Windows uses **ConPTY (node-pty native) with fresh-spawn only**. The fd-handoff / seamless-upgrade code path (`AdoptedPty`, `prepareUpgrade`, `adoptSnapshot`) is gated behind `platform !== "win32"`. On win32, `DaemonSupervisor.update()` routes to `forceRestart()` instead of the adopt path.

### Consequences
- **+** Eliminates a large body of POSIX-only code from the Windows path; ConPTY is well-supported by node-pty.
- **−** **UX regression on Windows:** updating the daemon restarts all terminal sessions (the documented destructive-restart fallback). Users lose open terminals on a daemon upgrade. This matches the existing documented fallback behavior and is accepted; tracked as a known gap in [windows-setup.md](./windows-setup.md).

---

## D3: IPC transport — named pipe via Node `net`

### Context
The pty-daemon speaks to its supervisor over a local socket. On POSIX this is a Unix domain socket (a filesystem entry) whose readiness is checked with `existsSync`, and whose permissions are set with `chmod` / cleaned with `unlink`. Windows named pipes (`\\.\pipe\...`) are **not filesystem entries** — `existsSync` / `chmod` / `unlink` do not apply.

### Decision
Use a **Windows named pipe** `\\.\pipe\superset-ptyd-<orgHash>` via Node's `net` module, connecting with the same `{ path }` option used for Unix sockets. Filesystem-based readiness checks (`existsSync`) are gated to POSIX; on Windows, readiness is determined by **connection polling** (attempt `net.connect`, retry until success or timeout).

### Consequences
- **+** One transport API (`net`) across platforms; only the path format and readiness strategy differ.
- **+** No new dependency — `net` is stdlib.
- **−** Slightly different readiness semantics (poll vs. fs check), but both are internal to the supervisor.

---

## D4: Process-tree kill — `taskkill /T /F` on Windows

### Context
To kill a terminal's child process tree (e.g. on Ctrl+C or session close), the POSIX path runs `spawnSync("ps")` to enumerate descendants and signals them via negative-pgid `process.kill(-id)` (process-group kill). Neither `ps` nor negative-pgid signaling exists on Windows.

### Decision
On win32, kill the process tree with **`taskkill /PID <pid> /T /F`** (`/T` = tree, `/F` = force). There are no process groups involved. POSIX keeps the `ps` + process-group signaling path. Both are exposed through the shared `killProcessTree()` helper.

### Consequences
- **+** Correct tree kill on Windows without process-group emulation.
- **−** `taskkill /T` relies on the Windows job/child relationship, which is generally reliable but can miss grandchildren spawned with `DETACHED_PROCESS` in edge cases. Acceptable for the terminal-close use case.

---

## D5: Shell strategy — PowerShell-primary + Git-Bash detection for the agent

### Context
There are two distinct shell surfaces: (1) the **interactive terminal** the user types into, and (2) the **agent's command-execution shell** (where `createMastraCode` runs the agent's shell commands). The interactive terminal already resolves `pwsh` / `cmd.exe` via the host-service shell resolver. The agent shell is harder: the agent's command syntax is bash-style, so a POSIX-capable shell is strongly preferred on Windows. This is distinct from the interactive-terminal resolver (`resolveConfiguredShell`), which on win32 returns `cmd.exe` / COMSPEC.

### Decision
The agent-shell resolver lives at **`@superset/shared/agent-shell`** (`resolveAgentShell()`). Probe order on win32: **Git Bash** (`where bash.exe`, then known `C:\Program Files\Git\...\bash.exe` paths) → **PowerShell** (`pwsh` 7+ preferred, else `powershell.exe`) → **cmd.exe** (`%COMSPEC%`, else `cmd.exe`). On POSIX it returns the account shell (`$SHELL` → `/bin/sh`). The resolver is cached per process (discovery is `spawnSync`-based on win32 and must not run per command).

### Consequences
- **+** Git Bash (if installed) gives the agent a POSIX shell, matching macOS/Linux command behavior most closely.
- **+** Graceful fallback ladder; no hard dependency on Git for Windows.
- **−** **Pending wiring:** `createMastraCode` (external `mastracode` package) currently has no shell option, so on win32 the agent still uses the system default shell. The resolver is built and tested but not yet threaded into `createMastraCode()`. Tracked as a known gap in [windows-setup.md](./windows-setup.md) (item b). Until wired, agent command execution on Windows may use a non-POSIX shell.

---

## D6: No OS sandbox — advisory consent only (cross-platform)

### Context
Superset has **no sandbox on any platform** — no seatbelt (macOS), no landlock/bwrap (Linux), no Job-Object/AppContainer (Windows). The `sandbox_access_request` prompt the user sees is an **advisory consent** flow: it asks permission, but there is no OS-level isolation behind it.

### Decision
Do **not** build a sandbox for the Windows port. Document the advisory-only boundary in user-facing docs ([windows-setup.md](./windows-setup.md)) and leave the consent prompt as-is. Adding real process isolation is a separate, cross-platform security project, explicitly out of scope for the Windows port.

### Consequences
- **+** No new platform-specific security surface to maintain; the Windows port doesn't widen the trust boundary beyond what macOS/Linux already have.
- **−** The `sandbox_access_request` prompt may imply isolation to users that does not exist. Mitigated by documentation; a future hardening project would address this on all platforms simultaneously.

---

## D7: Root scripts — cross-platform `.ts` (run via `bun`), not parallel `.sh` / `.ps1`

### Context
The root `package.json` scripts (`postinstall`, `lint`, `release:*`, `check:desktop-git-env`) were `.sh` files using bash/`rg`/`grep`/`[[ ]]`. On Windows, `bun install`'s postinstall step ran these and failed because `cmd.exe` can't parse them. The conventional fix — maintain parallel `.ps1` equivalents — doubles the maintenance surface and invites drift.

### Decision
Port root scripts to **cross-platform `.ts` files run via `bun`** (e.g. `scripts/postinstall.ts`, `scripts/lint.ts`), instead of authoring parallel `.sh` / `.ps1` versions. The repo already runs on Bun, so a single `.ts` implementation works identically on all platforms. Where a script genuinely needs platform behavior, it branches internally on `process.platform`. `.gitattributes` pins line endings (`*.sh text eol=lf`, `*.cmd text eol=crlf`) so the remaining shell-specific files stay correct per platform.

### Consequences
- **+** One implementation per script; no `.sh` / `.ps1` drift.
- **+** TypeScript gives type safety and IDE support the shell versions lacked.
- **−** Slightly heavier than a raw shell script (Bun must load), but these run at install/lint/release time where the overhead is negligible.
