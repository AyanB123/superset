import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgentShellWin32 } from "@superset/shared/agent-shell";
import { env } from "shared/env.shared";
import {
	buildWrapperScript,
	createWrapper,
	isSupersetManagedHookCommand,
	reconcileManagedEntries,
	writeFileIfChanged,
} from "./agent-wrappers-common";
import { HOOKS_DIR } from "./paths";

export const CURSOR_HOOK_SCRIPT_NAME = "cursor-hook.sh";

const CURSOR_HOOK_SIGNATURE = "# Superset cursor hook";
const CURSOR_HOOK_VERSION = "v3";
export const CURSOR_HOOK_MARKER = `${CURSOR_HOOK_SIGNATURE} ${CURSOR_HOOK_VERSION}`;

const CURSOR_HOOK_TEMPLATE_PATH = path.join(
	__dirname,
	"templates",
	"cursor-hook.template.sh",
);

interface CursorHookEntry {
	command: string;
	[key: string]: unknown;
}

interface CursorHooksJson {
	version?: number;
	hooks?: Record<string, CursorHookEntry[]>;
	[key: string]: unknown;
}

export function getCursorHookScriptPath(): string {
	return path.join(HOOKS_DIR, CURSOR_HOOK_SCRIPT_NAME);
}

export function getCursorGlobalHooksJsonPath(): string {
	return path.join(os.homedir(), ".cursor", "hooks.json");
}

// ---------------------------------------------------------------------------
// Windows: cursor-notify.cmd launcher (Git Bash → cursor-hook.sh)
// ---------------------------------------------------------------------------

/**
 * Windows: the per-agent .cmd launcher that runs cursor-hook.sh via Git Bash.
 *
 * Cursor pipes the hook JSON payload via STDIN AND passes the event name as
 * argv (see our hooks.json entries: `${launcher} SessionStart`). The launcher
 * forwards both — cmd's `%*` carries the event arg, stdin flows through to
 * bash → cursor-hook.sh. cursor-hook.sh prints the auto-approve JSON
 * (`{"continue":true}` for PermissionRequest) on STDOUT, which bash writes to
 * the inherited stdout pipe back to Cursor. SUPERSET_AGENT_ID /
 * SUPERSET_HOST_AGENT_HOOK_URL / SUPERSET_TERMINAL_ID are inherited from the
 * Superset terminal cursor-agent runs in (host-service/env.ts).
 */
const CURSOR_WIN32_LAUNCHER_NAME = "cursor-notify.cmd";
function getCursorWin32LauncherPath(): string {
	return path.join(HOOKS_DIR, CURSOR_WIN32_LAUNCHER_NAME);
}

/**
 * Writes the Windows .cmd launcher. Returns false (skip Cursor setup) if Git
 * Bash isn't installed — cursor-hook.sh is bash and can't run under
 * pwsh/cmd (which resolveAgentShellWin32 falls back to when Git Bash is absent).
 * Cursor also fails to execute extensionless scripts on Windows, so a .cmd
 * shim is mandatory (not optional) for the hook command.
 */
function createCursorWin32Launcher(): boolean {
	const bashPath = resolveAgentShellWin32();
	if (!/(^|[\\/])bash(\.exe)?$/i.test(bashPath)) {
		console.warn(
			"[agent-setup] Git Bash not found; cannot install Cursor notify hook on Windows.",
		);
		return false;
	}
	// CRLF line endings + a trailing newline so .cmd is well-formed on Windows.
	// %* forwards the event-name argv from hooks.json; stdin passes through.
	const content = [
		"@echo off",
		"REM Superset Cursor notify launcher (Windows). Runs cursor-hook.sh via Git Bash.",
		"REM Cursor pipes hook JSON via stdin and passes the event name as argv (%*).",
		"REM cursor-hook.sh emits the auto-approve JSON on stdout, which flows back to Cursor.",
		'set "SUPERSET_AGENT_ID=cursor-agent"',
		`"${bashPath}" "%~dp0${CURSOR_HOOK_SCRIPT_NAME}" %*`,
		"",
	].join("\r\n");
	const changed = writeFileIfChanged(
		getCursorWin32LauncherPath(),
		content,
		0o755,
	);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} Cursor notify launcher (Windows)`,
	);
	return true;
}

/**
 * The command written into ~/.cursor/hooks.json. Unix inlines the hook script
 * path (event name passed as a trailing argv: `${script} SessionStart`);
 * Windows points at the .cmd launcher, which forwards %* (the event arg) and
 * stdin to cursor-hook.sh via Git Bash.
 */
function getCursorManagedHookCommand(): string {
	if (process.platform === "win32") {
		return `"${getCursorWin32LauncherPath()}"`;
	}
	return getCursorHookScriptPath();
}

function isManagedCursorHookCommand(
	command: string | undefined,
	hookScriptPath: string,
): boolean {
	return (
		command?.includes(hookScriptPath) ||
		(process.platform === "win32" &&
			command?.includes(getCursorWin32LauncherPath())) ||
		isSupersetManagedHookCommand(command, CURSOR_HOOK_SCRIPT_NAME)
	);
}

export function getCursorHookScriptContent(): string {
	const template = fs.readFileSync(CURSOR_HOOK_TEMPLATE_PATH, "utf-8");
	return template
		.replace("{{MARKER}}", CURSOR_HOOK_MARKER)
		.replaceAll("{{DEFAULT_PORT}}", String(env.DESKTOP_NOTIFICATIONS_PORT));
}

/**
 * Reads existing ~/.cursor/hooks.json, merges our hook entries (identified by
 * hook script path), and preserves any user-defined hooks.
 */
export function getCursorHooksJsonContent(hookScriptPath: string): string {
	const globalPath = getCursorGlobalHooksJsonPath();

	let existing: CursorHooksJson = {};
	try {
		if (fs.existsSync(globalPath)) {
			existing = JSON.parse(fs.readFileSync(globalPath, "utf-8"));
		}
	} catch {
		console.warn(
			"[agent-setup] Could not parse existing ~/.cursor/hooks.json, merging carefully",
		);
	}

	if (!existing.version) {
		existing.version = 1;
	}
	if (!existing.hooks || typeof existing.hooks !== "object") {
		existing.hooks = {};
	}

	// On Windows the managed command is the .cmd launcher path; on Unix it's the
	// hook script path. Either way the event name is appended as argv.
	const managedCommand = getCursorManagedHookCommand();
	const ourHooks: Record<string, CursorHookEntry> = {
		sessionStart: { command: `${managedCommand} SessionStart` },
		sessionEnd: { command: `${managedCommand} SessionEnd` },
		beforeSubmitPrompt: { command: `${managedCommand} Start` },
		stop: { command: `${managedCommand} Stop` },
		beforeShellExecution: {
			command: `${managedCommand} PermissionRequest`,
		},
		beforeMCPExecution: {
			command: `${managedCommand} PermissionRequest`,
		},
	};

	for (const [eventName, ourEntry] of Object.entries(ourHooks)) {
		const current = existing.hooks[eventName];
		const { entries } = reconcileManagedEntries({
			current,
			desired: [ourEntry],
			isManaged: (entry: CursorHookEntry) =>
				isManagedCursorHookCommand(entry.command, hookScriptPath),
			isEquivalent: (entry: CursorHookEntry, desiredEntry: CursorHookEntry) =>
				entry.command === desiredEntry.command,
		});
		existing.hooks[eventName] = entries;
	}

	return JSON.stringify(existing, null, 2);
}

export function createCursorHookScript(): void {
	// On Windows the .cmd launcher executes this script via Git Bash, so it's
	// still required on both platforms.
	const scriptPath = getCursorHookScriptPath();
	const content = getCursorHookScriptContent();
	const changed = writeFileIfChanged(scriptPath, content, 0o755);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} Cursor hook script`,
	);
}

export function createCursorAgentWrapper(): void {
	const script = buildWrapperScript("cursor-agent", `exec "$REAL_BIN" "$@"`, {
		agentId: "cursor-agent",
	});
	createWrapper("cursor-agent", script);
}

export function createCursorHooksJson(): void {
	if (process.platform === "win32") {
		// Write the .cmd launcher (Git Bash → cursor-hook.sh) first; skip Cursor
		// entirely if Git Bash isn't installed (the hook command would dangle).
		if (!createCursorWin32Launcher()) return;
	}
	const hookScriptPath = getCursorHookScriptPath();
	const globalPath = getCursorGlobalHooksJsonPath();
	const content = getCursorHooksJsonContent(hookScriptPath);

	const dir = path.dirname(globalPath);
	fs.mkdirSync(dir, { recursive: true });
	const changed = writeFileIfChanged(globalPath, content, 0o644);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} Cursor hooks.json`,
	);
}
