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

export const GEMINI_HOOK_SCRIPT_NAME = "gemini-hook.sh";

const GEMINI_HOOK_SIGNATURE = "# Superset gemini hook";
const GEMINI_HOOK_VERSION = "v3";
export const GEMINI_HOOK_MARKER = `${GEMINI_HOOK_SIGNATURE} ${GEMINI_HOOK_VERSION}`;

const GEMINI_HOOK_TEMPLATE_PATH = path.join(
	__dirname,
	"templates",
	"gemini-hook.template.sh",
);

interface GeminiHookConfig {
	type: string;
	command: string;
	[key: string]: unknown;
}

interface GeminiHookDefinition {
	matcher?: string;
	command?: string;
	hooks?: GeminiHookConfig[];
	[key: string]: unknown;
}

interface GeminiSettingsJson {
	hooks?: Record<string, GeminiHookDefinition[]>;
	[key: string]: unknown;
}

export function getGeminiHookScriptPath(): string {
	return path.join(HOOKS_DIR, GEMINI_HOOK_SCRIPT_NAME);
}

export function getGeminiSettingsJsonPath(): string {
	return path.join(os.homedir(), ".gemini", "settings.json");
}

// ---------------------------------------------------------------------------
// Windows: gemini-notify.cmd launcher (Git Bash → gemini-hook.sh)
// ---------------------------------------------------------------------------

/**
 * Windows: the per-agent .cmd launcher that runs gemini-hook.sh via Git Bash.
 *
 * Gemini pipes the hook JSON payload via STDIN (no argv) and REQUIRES valid
 * JSON on STDOUT before exit (it blocks / degrades otherwise). The launcher
 * forwards stdin to bash → gemini-hook.sh, which prints `{}` on stdout; that
 * flows through the inherited stdout pipe back to Gemini. SUPERSET_AGENT_ID /
 * SUPERSET_HOST_AGENT_HOOK_URL / SUPERSET_TERMINAL_ID are inherited from the
 * Superset terminal gemini runs in (host-service/env.ts).
 */
const GEMINI_WIN32_LAUNCHER_NAME = "gemini-notify.cmd";
function getGeminiWin32LauncherPath(): string {
	return path.join(HOOKS_DIR, GEMINI_WIN32_LAUNCHER_NAME);
}

/**
 * Writes the Windows .cmd launcher. Returns false (skip Gemini setup) if Git
 * Bash isn't installed — gemini-hook.sh is bash and can't run under pwsh/cmd
 * (which resolveAgentShellWin32 falls back to when Git Bash is absent).
 */
function createGeminiWin32Launcher(): boolean {
	const bashPath = resolveAgentShellWin32();
	if (!/(^|[\\/])bash(\.exe)?$/i.test(bashPath)) {
		console.warn(
			"[agent-setup] Git Bash not found; cannot install Gemini notify hook on Windows.",
		);
		return false;
	}
	// CRLF line endings + a trailing newline so .cmd is well-formed on Windows.
	// Gemini passes the payload via stdin (no argv), so no %* forward here.
	const content = [
		"@echo off",
		"REM Superset Gemini notify launcher (Windows). Runs gemini-hook.sh via Git Bash.",
		"REM Gemini pipes hook JSON via stdin; gemini-hook.sh prints {} on stdout before exit.",
		'set "SUPERSET_AGENT_ID=gemini"',
		`"${bashPath}" "%~dp0${GEMINI_HOOK_SCRIPT_NAME}"`,
		"",
	].join("\r\n");
	const changed = writeFileIfChanged(
		getGeminiWin32LauncherPath(),
		content,
		0o755,
	);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} Gemini notify launcher (Windows)`,
	);
	return true;
}

/**
 * The command written into ~/.gemini/settings.json. Unix inlines the hook
 * script path; Windows points at the .cmd launcher (Gemini passes the payload
 * via stdin, which flows through to gemini-hook.sh via Git Bash).
 */
function getGeminiManagedHookCommand(): string {
	if (process.platform === "win32") {
		return `"${getGeminiWin32LauncherPath()}"`;
	}
	return getGeminiHookScriptPath();
}

function isManagedGeminiHookCommand(
	definition: GeminiHookDefinition,
	hookScriptPath: string,
): boolean {
	return (
		isSupersetManagedHookCommand(definition.command, GEMINI_HOOK_SCRIPT_NAME) ||
		Boolean(
			definition.hooks?.some(
				(hook) =>
					hook.command?.includes(hookScriptPath) ||
					(process.platform === "win32" &&
						hook.command?.includes(getGeminiWin32LauncherPath())) ||
					isSupersetManagedHookCommand(hook.command, GEMINI_HOOK_SCRIPT_NAME),
			),
		)
	);
}

export function getGeminiHookScriptContent(): string {
	const template = fs.readFileSync(GEMINI_HOOK_TEMPLATE_PATH, "utf-8");
	return template
		.replace("{{MARKER}}", GEMINI_HOOK_MARKER)
		.replaceAll("{{DEFAULT_PORT}}", String(env.DESKTOP_NOTIFICATIONS_PORT));
}

/**
 * Reads existing ~/.gemini/settings.json, merges our hook definitions (identified by
 * hook script path), and preserves any user-defined settings/hooks.
 *
 * Gemini CLI uses a two-level nesting format:
 *   { hooks: { EventName: [{ matcher?, hooks: [{ type, command }] }] } }
 */
export function getGeminiSettingsJsonContent(hookScriptPath: string): string {
	const globalPath = getGeminiSettingsJsonPath();

	let existing: GeminiSettingsJson = {};
	try {
		if (fs.existsSync(globalPath)) {
			existing = JSON.parse(fs.readFileSync(globalPath, "utf-8"));
		}
	} catch {
		console.warn(
			"[agent-setup] Could not parse existing ~/.gemini/settings.json, merging carefully",
		);
	}

	if (!existing.hooks || typeof existing.hooks !== "object") {
		existing.hooks = {};
	}

	// On Windows the managed command is the .cmd launcher path; on Unix it's
	// the hook script path.
	const managedCommand = getGeminiManagedHookCommand();

	// HookEventName values from gemini-cli's packages/core/src/hooks/types.ts.
	const eventNames = [
		"SessionStart",
		"SessionEnd",
		"BeforeAgent",
		"AfterAgent",
		"AfterTool",
	];

	for (const eventName of eventNames) {
		const current = existing.hooks[eventName];
		const desiredEntries: GeminiHookDefinition[] = [
			{
				hooks: [{ type: "command", command: managedCommand }],
			},
		];
		const { entries } = reconcileManagedEntries({
			current,
			desired: desiredEntries,
			isManaged: (definition: GeminiHookDefinition) =>
				isManagedGeminiHookCommand(definition, hookScriptPath),
			isEquivalent: (
				definition: GeminiHookDefinition,
				desiredDefinition: GeminiHookDefinition,
			) =>
				JSON.stringify(definition.hooks ?? []) ===
				JSON.stringify(desiredDefinition.hooks ?? []),
		});
		existing.hooks[eventName] = entries;
	}

	return JSON.stringify(existing, null, 2);
}

export function createGeminiHookScript(): void {
	// On Windows the .cmd launcher executes this script via Git Bash, so it's
	// still required on both platforms.
	const scriptPath = getGeminiHookScriptPath();
	const content = getGeminiHookScriptContent();
	const changed = writeFileIfChanged(scriptPath, content, 0o755);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} Gemini hook script`,
	);
}

export function createGeminiWrapper(): void {
	const script = buildWrapperScript("gemini", `exec "$REAL_BIN" "$@"`, {
		agentId: "gemini",
	});
	createWrapper("gemini", script);
}

export function createGeminiSettingsJson(): void {
	if (process.platform === "win32") {
		// Write the .cmd launcher (Git Bash → gemini-hook.sh) first; skip Gemini
		// entirely if Git Bash isn't installed (the hook command would dangle).
		if (!createGeminiWin32Launcher()) return;
	}
	const hookScriptPath = getGeminiHookScriptPath();
	const globalPath = getGeminiSettingsJsonPath();
	const content = getGeminiSettingsJsonContent(hookScriptPath);

	const dir = path.dirname(globalPath);
	fs.mkdirSync(dir, { recursive: true });
	const changed = writeFileIfChanged(globalPath, content, 0o644);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} Gemini settings.json`,
	);
}
