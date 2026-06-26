# Superset — Full Native Windows Support

**Status:** Proposed · **Scope:** Cross-cutting (desktop, host-service, pty-daemon, cli, shared, marketing) · **Date:** 2026-06-23

> Goal: get the superset monorepo running with **full functionality** on Windows — desktop app boots, terminals spawn, the coding agent runs commands, CLI installs standalone, and all agent-extension surfaces (slash-commands, skills, MCP, agent hooks/wrappers) work natively.

---

## 0. Premise — why this is NOT a "port"

Superset is Electron + node-pty + better-sqlite3. All three ship **native Windows support** (ConPTY, prebuilt `.node` binaries). The codebase is already ~70% cross-platform: scattered, working `process.platform === "win32"` branches exist in `DaemonSupervisor` (pty-daemon spawn), `host-info` (machine-id via `reg query`), `bundled-cli.ts` (`.cmd` shim), `electron-builder.ts` (NSIS win target), and `user-shell.ts` (COMSPEC resolver).

The work is therefore **completing specific POSIX-only paths**, not introducing a new architecture. A heavy interface-refactor (à la a fresh port) is over-engineering: `node-pty` already abstracts ConPTY, and Node's `net` module already abstracts named pipes behind the same `{ path }` option on both platforms.

### Out of scope (flagged, not solved here)
- **OS sandboxing.** Superset has **no sandbox on any platform** — no seatbelt/landlock/bwrap/Job-Object/AppContainer. `sandbox_access_request` is an advisory consent prompt with no isolation behind it. Adding process isolation is a separate security project. We will *document* this, not build it.
- **ACP.** Repo-wide search finds **zero** ACP source code — superset neither implements nor consumes Agent Client Protocol. "ACP Windows support" is N/A. The real agent-extension gap is the **bash hook/wrapper layer** (see Wave 1/H).

---

## 1. Root blockers (verified, file:line)

### Tier 1 — won't boot/spawn/build
| # | Location | Problem | Fix |
|---|---|---|---|
| 1 | `packages/pty-daemon/src/Pty/Pty.ts:205` | `getMasterFd()` reads node-pty private Unix-only `_fd`; asserted at **every spawn** → crashes all terminals on Windows | Gate behind `platform !== "win32"` |
| 2 | `packages/host-service/src/terminal/clean-shell-env.ts:132,143` | Spawns login shell (`sh -i -l -c`) to capture env; on win32 `cmd.exe` can't parse it → 8s hang then fail | Short-circuit to `process.env` on win32 |
| 3 | `packages/host-service/src/daemon/DaemonSupervisor.ts:109-115` + `Server.ts:63,71,83` | Unix socket path + `chmod`/`unlink`/`existsSync` readiness; Windows named pipes aren't filesystem entries | `\\.\pipe\...` prefix; guard fs-based readiness to connect-polling |
| 4 | `packages/pty-daemon/src/process-tree.ts:103,174` | `spawnSync("ps")` + negative-pgid `process.kill(-id)` — POSIX-only → orphaned shells | `taskkill /PID /T /F` branch |
| 5 | `packages/pty-daemon/src/Pty/Pty.ts:66-80,227-347` + `Server.ts:144-224` | fd-handoff/seamless-upgrade (`AdoptedPty`, `prepareUpgrade`, `stty`, `tty.ReadStream`) — POSIX-only optimization | Gate behind platform; Windows `update()`→`restart()` |
| 6 | `package.json:27-38` (`postinstall`,`lint`,`release:*`,`check:desktop-git-env`) | Root scripts are `.sh` with bash/`rg`/`grep`/`[[ ]]` → `bun install` postinstall fails on Windows | Node (`.ts` via `bun`) or `.ps1` equivalents |
| 7 | `apps/desktop/scripts/copy-native-modules.ts:244` | `execSync('curl ... | tar xz ... --strip-components=1')` breaks in `cmd.exe` | Node `fetch()` + `tar`/`zlib` extract |
| 8 | `packages/host-service/src/providers/git/askpass.ts:7-15` | Writes `#!/bin/sh` script + `chmod 700`; git's `GIT_ASKPASS` can't execute on Windows | Emit `.cmd` on win32 (`@echo off` + `if "%~1"`) |

### Tier 2 — runs but features broken
- `apps/desktop/src/main/lib/agent-setup/notify-hook.ts:6,50` + templates (`notify-hook`, `codex-wrapper-exec`, `cursor-hook`, `gemini-hook`, `copilot-hook`) — all `#!/bin/bash` with `/tmp/`, `grep`, `tr`, `date -u`. Installed unconditionally as bootstrap hooks. **→ Node dispatcher via `process.execPath`.**
- `apps/desktop/src/lib/trpc/routers/workspaces/utils/git.ts:789` — `spawn("/bin/rm",["-rf",...])`. **→ `fs.rm` on non-darwin.**
- `packages/chat/src/server/desktop/auth/anthropic/anthropic.ts:134` — keychain darwin-only. **→ Windows Credential Manager (`cmdkey`) branch.**
- `apps/desktop/src/main/lib/play-sound.ts:30-59` — no win32 branch. **→ `rundll32`/PowerShell `SoundPlayer`.**
- `apps/desktop/src/lib/trpc/routers/external/helpers.ts:93-124` — no win32 command table. **→ `start ""`/`cmd /c`.**
- `apps/desktop/src/main/terminal-host/session.ts:210,1004` + `host-service/src/terminal/terminal.ts:1021` — `shell.split("/").pop()`. **→ `path.basename`.**
- `packages/host-service/.../setup-terminal.ts:103` — `bash ${script}` fallback for `.superset/setup.sh`. **→ `.ps1` fallback.**
- Agent shell execution lives in `mastracode` (external, not in checkout). No shell resolver is threaded into `createMastraCode()` (chat.ts:466 / service.ts:147). **→ dual resolver (Git Bash → pwsh → cmd).**

### Tier 3 — already safe / cosmetic
- `macos-process-metrics` (double try/catch, `|| echo skipped`) — safe; optionally platform-gate.
- `koffi`/`sharp` in root `trustedDependencies` — not actual runtime deps; optional cleanup.
- Slash-command discovery (`registry.ts:139` `.agents/commands` fallback) — already win-complete; symlink optional.
- MCP configs — HTTP/SSE URLs + `npx` (win-safe via PATHEXT).

---

## 2. Build toolchain prerequisite (environment, not code)

`node-pty@1.1.0` has **no prebuilt binary**. `electron-builder install-app-deps` rebuilds it against Electron's ABI via node-gyp → requires:
- **Visual Studio Build Tools 2022** (Desktop C++ workload: MSVC v143 + Win11 SDK)
- **Python 3.11+** (node-gyp)
- `npm config set msvs_version 2022`

Required for **both** distribution paths (desktop `.exe` rebuild + standalone CLI's bundled `superset-host`, whose host-service.js loads node-pty). better-sqlite3/node-pty/native-keymap rebuild here; `@parcel/watcher`, `@libsql`, `@ast-grep/napi`, `@duckdb/node-bindings` all have win32-x64 prebuilts already handled by `copy-native-modules`/`validate-native-runtime`.

---

## 3. Conventions (all waves)
- **Zero Unix behavior change.** Wave 0 + abstractions must not alter macOS/Linux paths. Every Windows branch is additive/gated.
- **`bun run lint:fix` then `bun run lint` exits 0** before any commit (CI fails on Biome warnings).
- Conventional commits via `gh`. Branch per wave/agent.
- **Stubs first, correctness second.** "Boots and runs" outranks "perfect" at each gate.
- New platform logic centralized in a shared module (`packages/shared/src/platform/`): `ptySocketPath()`, `killProcessTree()`, `resolveShellEnv()`, `getAgentShell()`, `isWindows()`. Existing working branches left untouched (no risky refactor-in).

---

## 4. Wave plan (dependency-gated fan-out)

### Wave 0 — Foundation  *(serial; owner: main; gates everything)*
Deliverables:
1. `packages/shared/src/platform/` module with the 5 helpers above.
2. Cross-platform root scripts: `scripts/postinstall.{ts,ps1}`, `lint`, `release:*`, `check-desktop-git-env` → Node/`.ps1`; update `package.json` to dispatch by platform (keep `.sh` for unix).
3. `.gitattributes` — `* text=auto eol=lf`, `*.sh text eol=lf`, `*.cmd text eol=crlf`.
4. `clean-shell-env.ts` → short-circuit win32.
5. `Pty.ts:205` `getMasterFd` gate.
6. `ptyDaemonSocketPath` named-pipe on win32 + readiness guards.
7. `process-tree.ts` `taskkill /T /F` branch via `killProcessTree()`.
8. fd-handoff gating (`AdoptedPty`/`prepareUpgrade`/`adoptSnapshot` → `platform !== "win32"`; `DaemonSupervisor.update()` win32 → `restart()`).
9. `path.basename` at the 3 split sites.

**Gate (must pass before Wave 1):** `bun install`, `bun build`, `bun run lint`, `bun run typecheck` all green on Windows; full suite green on Unix; one PTY session spawns on Windows (manual smoke).

### Wave 1 — Parallel backends  *(fan out: 4 agents, disjoint files)*
| Agent | Surface | Files | Deliverable |
|---|---|---|---|
| **G** | Git auth | `packages/host-service/src/providers/git/askpass.ts` (+ `*GitCredentialProvider.ts`) | win32 `.cmd` askpass (or GCM); keep `.sh`+chmod posix |
| **H** | Hooks/wrappers | `apps/desktop/src/main/lib/agent-setup/**`, `desktop-agent-capabilities.ts`, `git.ts:789`, `anthropic.ts:134` | Node dispatcher for notify; platform-aware wrapper emit; `fs.rm` fix; Credential Manager; filter setup targets by platform |
| **N** | Native module fetch | `apps/desktop/scripts/copy-native-modules.ts`, `validate-native-runtime.ts` | `fetch+tar` rewrite; `TARGET_PLATFORM` env-aware validation |
| **C** | CLI win32 build | `packages/cli/{cli.config.ts,scripts/build-dist.ts,src/lib/host/spawn.ts,src/commands/update/command.ts}` | `win32-x64` target; `superset-host.cmd` launcher; `resolveHostBinary` `.exe/.cmd`; `update` zip path |

**Gate:** each agent's surface lint/typechecks; Unix unaffected; CI windows job on `G`/`N`/`C` smoke.

### Wave 2 — Platform feature dispatch  *(1–2 agents, after Wave 1)*
play-sound win32; external-app helpers win32 table; macos-process-metrics explicit gate; setup-terminal `.ps1` fallback; dual shell resolver (`getAgentShell`: Git Bash → pwsh → cmd) threaded into `createMastraCode()`.

### Wave 3 — Distribution + CI + docs  *(1 agent, after Wave 2)*
`apps/marketing/public/cli/install.ps1`; relax `install.sh` hard-reject → pointer; marketing download page Windows path (drop win waitlist); `.github/workflows/build-cli.yml` + desktop-release `windows-latest` job; `packages/cli/scripts/smoke-test.ps1`; ADR (`<app>/docs/`) recording platform-primitives + dual-shell + no-OS-sandbox decisions; README/AGENTS drop "macOS/Linux only".

### Wave 4 — Tests + live verification  *(1 agent, after Wave 3)*
`/tmp` → `os.tmpdir()` in test setups; git-test POSIX quoting; then **live boot** as final gate: `bun install` → `bun dev:desktop` → open app → spawn a real terminal → run a slash-command/skill → verify CLI `superset auth login` flow. Document the sandbox advisory-only boundary in user-facing docs.

---

## 5. Verification definition of done
1. Fresh Windows clone: `bun install` (postinstall green) → `bun build` → `bun run lint`/`typecheck` green.
2. `bun dev:desktop` launches; a terminal tab spawns a shell (PowerShell) and accepts input; Ctrl+C kills child trees (taskkill).
3. A coding agent session runs a command in a workspace.
4. `superset auth login` completes (loopback OAuth + `clip`).
5. Standalone `install.ps1` installs `superset.exe` + `superset-host.cmd`, daemon starts over HTTP loopback, `superset status` reports healthy.
6. CI `windows-latest` job builds CLI + desktop `.exe` and runs smoke.
7. Unix CI unchanged (zero behavior regression).

## 6. Risks
- **node-pty compile** is the single biggest environment dependency; mitigated by documenting VS Build Tools prereq (§2) and considering a prebuilt node-pty fork only if compilation proves flaky.
- **mastracode internals** (agent shell/sandbox) are not in this checkout; Wave 2's resolver threads a shell in, but ultimate agent-command behavior on Windows can only be confirmed at live boot (Wave 4).
- **fd-handoff removal on Windows** is a UX regression (shells lost on daemon upgrade); acceptable, matches existing documented destructive-restart fallback, documented in ADR.
