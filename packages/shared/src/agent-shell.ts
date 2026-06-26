import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";

/**
 * Shell resolution for the coding agent's command-execution surface.
 *
 * The agent runtime (created via `createMastraCode`) runs shell commands in the
 * user's workspace. On macOS/Linux the account shell works as-is; on Windows a
 * POSIX shell is required for the agent's bash-style command syntax, so we probe
 * Git Bash first and fall back to PowerShell, then cmd.exe.
 *
 * This is distinct from {@link "../host-service"} `resolveConfiguredShell`,
 * which picks the shell for *interactive* user terminals (and on win32 returns
 * cmd.exe / COMSPEC). The agent needs a POSIX-capable shell on Windows.
 */

export interface AgentShellProbes {
	/**
	 * Test seam: resolves a binary name to an absolute path, like `where`/`which`.
	 * Return `null` when not found. Defaults to `where` on win32 / `which` posix.
	 */
	which?: (bin: string) => string | null;
	/** Test seam: filesystem existence check. Defaults to `existsSync`. */
	exists?: (path: string) => boolean;
	/** Test seam: the OS account shell (posix only). */
	accountShell?: string | null;
}

export interface AgentShellOptions extends AgentShellProbes {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
}

function defaultWhich(
	platform: NodeJS.Platform,
): (bin: string) => string | null {
	return (bin: string) => {
		try {
			const cmd = platform === "win32" ? "where" : "which";
			const out = spawnSync(cmd, [bin], {
				encoding: "utf8",
				shell: platform === "win32",
			});
			if (out.status !== 0 || !out.stdout.trim()) return null;
			// `where` can return multiple lines; take the first.
			return out.stdout.trim().split(/\r?\n/)[0] || null;
		} catch {
			return null;
		}
	};
}

/**
 * Known Git Bash install locations, in priority order. Git for Windows ships
 * `bin\bash.exe` (the MSYS2 bash) and `usr\bin\bash.exe`; both work, prefer the
 * canonical `bin` install.
 */
const GIT_BASH_CANDIDATES = [
	"C:\\Program Files\\Git\\bin\\bash.exe",
	"C:\\Program Files\\Git\\usr\\bin\\bash.exe",
	"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
	"C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
] as const;

/**
 * Resolve a POSIX-capable shell for agent command execution on Windows.
 *
 * Probe order:
 *   1. Git Bash — `where bash.exe`, else the known Program Files paths.
 *   2. PowerShell — `pwsh` (PowerShell 7+), else `powershell.exe` (Windows PowerShell).
 *   3. cmd.exe — `env.COMSPEC`, else `"cmd.exe"`.
 *
 * Returns the resolved absolute path (or bare command name for the fallback).
 */
export function resolveAgentShellWin32(
	options: AgentShellOptions = {},
): string {
	const which = options.which ?? defaultWhich("win32");
	const exists = options.exists ?? ((p: string) => existsSync(p));

	// 1. Git Bash
	const bashFromPath = which("bash.exe") ?? which("bash");
	if (bashFromPath) return bashFromPath;
	for (const candidate of GIT_BASH_CANDIDATES) {
		if (exists(candidate)) return candidate;
	}

	// 2. PowerShell (pwsh 7+ preferred over Windows PowerShell)
	const pwsh = which("pwsh") ?? which("pwsh.exe");
	if (pwsh) return pwsh;
	const powershell = which("powershell") ?? which("powershell.exe");
	if (powershell) return powershell;

	// 3. cmd.exe
	return options.env?.COMSPEC ?? "cmd.exe";
}

/**
 * Resolve the agent shell for the current platform. On posix this is the
 * configured/account shell (same source as interactive terminals); on win32 it
 * runs the probe ladder above.
 */
export function resolveAgentShell(options: AgentShellOptions = {}): string {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") return resolveAgentShellWin32(options);

	// posix: account shell → $SHELL → /bin/sh
	const account =
		options.accountShell !== undefined
			? options.accountShell
			: posixAccountShell();
	if (account) return account;
	return options.env?.SHELL ?? "/bin/sh";
}

function posixAccountShell(): string | null {
	try {
		// userInfo().shell is null on win32; only meaningful on posix.
		const shell = (userInfo() as { shell?: unknown }).shell;
		return typeof shell === "string" && shell.trim() ? shell.trim() : null;
	} catch {
		return null;
	}
}

let cachedAgentShell: string | null = null;

/**
 * Cached resolver. Shell discovery is `spawnSync`-based on win32 and must not
 * run per agent command. The cache is process-lifetime; tests reset it via
 * {@link __resetAgentShellCache}.
 */
export function getAgentShell(): string {
	if (cachedAgentShell === null) {
		cachedAgentShell = resolveAgentShell();
	}
	return cachedAgentShell;
}

/** Test seam: clear the cached agent shell so a new platform/env takes effect. */
export function __resetAgentShellCache(): void {
	cachedAgentShell = null;
}
