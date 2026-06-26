import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgentShellWin32 } from "@superset/shared/agent-shell";
import {
	buildWrapperScript,
	createWrapper,
	isSupersetManagedHookCommand,
	writeFileIfChanged,
} from "./agent-wrappers-common";
import { getNotifyScriptPath, NOTIFY_SCRIPT_NAME } from "./notify-hook";
import { HOOKS_DIR, OPENCODE_CONFIG_DIR, OPENCODE_PLUGIN_DIR } from "./paths";

export const OPENCODE_PLUGIN_FILE = "superset-notify.js";

const OPENCODE_PLUGIN_SIGNATURE = "// Superset opencode plugin";
const OPENCODE_PLUGIN_VERSION = "v8";
export const OPENCODE_PLUGIN_MARKER = `${OPENCODE_PLUGIN_SIGNATURE} ${OPENCODE_PLUGIN_VERSION}`;

const OPENCODE_PLUGIN_TEMPLATE_PATH = path.join(
	__dirname,
	"templates",
	"opencode-plugin.template.js",
);
const CODEX_WRAPPER_EXEC_TEMPLATE_PATH = path.join(
	__dirname,
	"templates",
	"codex-wrapper-exec.template.sh",
);

/**
 * Returns the environment-scoped OpenCode plugin path under Superset home.
 */
export function getOpenCodePluginPath(): string {
	return path.join(OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN_FILE);
}

/** @see https://opencode.ai/docs/plugins */
export function getOpenCodeGlobalPluginPath(): string {
	const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
	const configHome = xdgConfigHome?.length
		? xdgConfigHome
		: path.join(os.homedir(), ".config");
	return path.join(configHome, "opencode", "plugin", OPENCODE_PLUGIN_FILE);
}

// ---------------------------------------------------------------------------
// Claude ~/.claude/settings.json direct merge (no wrapper needed)
// ---------------------------------------------------------------------------

interface ClaudeHookConfig {
	type: "command";
	command: string;
	timeout?: number;
	[key: string]: unknown;
}

interface ClaudeHookDefinition {
	matcher?: string;
	hooks?: ClaudeHookConfig[];
	[key: string]: unknown;
}

interface ClaudeSettingsJson {
	hooks?: Record<string, ClaudeHookDefinition[]>;
	[key: string]: unknown;
}

const CLAUDE_DYNAMIC_NOTIFY_RELATIVE_PATH = `hooks/${NOTIFY_SCRIPT_NAME}`;
const CLAUDE_DYNAMIC_NOTIFY_PATH_MARKER = `$SUPERSET_HOME_DIR/${CLAUDE_DYNAMIC_NOTIFY_RELATIVE_PATH}`;

/**
 * Windows: the per-agent .cmd launcher that runs notify.sh via Git Bash.
 * Claude pipes hook JSON via stdin, which cmd forwards to bash → notify.sh.
 * SUPERSET_HOME_DIR / SUPERSET_HOST_AGENT_HOOK_URL / SUPERSET_TERMINAL_ID are
 * inherited from the Superset terminal Claude runs in (host-service/env.ts).
 */
const CLAUDE_WIN32_LAUNCHER_NAME = "claude-notify.cmd";
function getClaudeWin32LauncherPath(): string {
	return path.join(HOOKS_DIR, CLAUDE_WIN32_LAUNCHER_NAME);
}

/**
 * Writes the Windows .cmd launcher. Returns false (skip Claude setup) if Git
 * Bash isn't installed — notify.sh is bash and can't run under pwsh/cmd (which
 * resolveAgentShellWin32 falls back to when Git Bash is absent).
 */
function createClaudeWin32Launcher(): boolean {
	const bashPath = resolveAgentShellWin32();
	if (!/(^|[\\/])bash(\.exe)?$/i.test(bashPath)) {
		console.warn(
			"[agent-setup] Git Bash not found; cannot install Claude notify hook on Windows.",
		);
		return false;
	}
	// CRLF line endings + a trailing newline so .cmd is well-formed on Windows.
	const content = [
		"@echo off",
		"REM Superset Claude notify launcher (Windows). Runs notify.sh via Git Bash.",
		"REM Claude pipes the hook JSON payload via stdin; it flows through to notify.sh.",
		'set "SUPERSET_AGENT_ID=claude"',
		`"${bashPath}" "%~dp0${NOTIFY_SCRIPT_NAME}"`,
		"",
	].join("\r\n");
	const changed = writeFileIfChanged(
		getClaudeWin32LauncherPath(),
		content,
		0o755,
	);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} Claude notify launcher (Windows)`,
	);
	return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns the command written into Claude's global hook config.
 *
 * Unix: a bash guard that runs notify.sh (resolved from SUPERSET_HOME_DIR) so
 * one shared ~/.claude/settings.json works for dev + prod. SUPERSET_AGENT_ID is
 * inlined so the payload carries identity even when Claude is launched outside
 * the Superset wrapper.
 *
 * Windows: the absolute path to the .cmd launcher (written by
 * {@link createClaudeWin32Launcher}). A bare .cmd path runs under cmd/PowerShell
 * without the cross-shell quoting hell of an inline `bash -c "..."`.
 */
export function getClaudeManagedHookCommand(): string {
	if (process.platform === "win32") {
		return `"${getClaudeWin32LauncherPath()}"`;
	}
	return `[ -n "$SUPERSET_HOME_DIR" ] && [ -x "$SUPERSET_HOME_DIR/${CLAUDE_DYNAMIC_NOTIFY_RELATIVE_PATH}" ] && SUPERSET_AGENT_ID=claude "$SUPERSET_HOME_DIR/${CLAUDE_DYNAMIC_NOTIFY_RELATIVE_PATH}" || true`;
}

function isManagedClaudeHookCommand(
	command: string | undefined,
	notifyScriptPath: string,
): boolean {
	return (
		command?.includes(notifyScriptPath) ||
		command?.includes(CLAUDE_DYNAMIC_NOTIFY_PATH_MARKER) ||
		(process.platform === "win32" &&
			command?.includes(getClaudeWin32LauncherPath())) ||
		isSupersetManagedHookCommand(command, NOTIFY_SCRIPT_NAME)
	);
}

function readExistingClaudeSettings(
	globalPath: string,
): ClaudeSettingsJson | null {
	if (!fs.existsSync(globalPath)) {
		return {};
	}

	try {
		const parsed = JSON.parse(fs.readFileSync(globalPath, "utf-8"));
		if (!isPlainObject(parsed)) {
			console.warn(
				"[agent-setup] Expected ~/.claude/settings.json to contain a JSON object; skipping Claude hook merge",
			);
			return null;
		}
		return parsed;
	} catch (error) {
		console.warn(
			"[agent-setup] Could not parse existing ~/.claude/settings.json; skipping Claude hook merge:",
			error,
		);
		return null;
	}
}

function removeManagedHooksFromDefinition(
	definition: ClaudeHookDefinition,
	isManagedCommand: (command: string | undefined) => boolean,
): ClaudeHookDefinition | null {
	if (!Array.isArray(definition.hooks)) {
		return definition;
	}

	const filteredHooks = definition.hooks.filter(
		(hook) => !isManagedCommand(hook.command),
	);

	if (filteredHooks.length === definition.hooks.length) {
		return definition;
	}

	if (filteredHooks.length === 0) {
		return null;
	}

	return {
		...definition,
		hooks: filteredHooks,
	};
}

/**
 * Returns the global Claude settings path used for native hook registration.
 */
export function getClaudeGlobalSettingsJsonPath(): string {
	return path.join(os.homedir(), ".claude", "settings.json");
}

/**
 * Reads existing ~/.claude/settings.json, merges our hook definitions
 * (identified by notify script path), and preserves any user-defined hooks
 * and all non-hook settings.
 *
 * Claude Code uses the same nested hook structure as Droid:
 *   { hooks: { EventName: [{ matcher?, hooks: [{ type, command }] }] } }
 */
export function getClaudeGlobalSettingsJsonContent(
	notifyScriptPath: string,
): string | null {
	const globalPath = getClaudeGlobalSettingsJsonPath();
	const existing = readExistingClaudeSettings(globalPath);
	if (!existing) return null;
	const managedHookCommand = getClaudeManagedHookCommand();

	if (!existing.hooks || typeof existing.hooks !== "object") {
		existing.hooks = {};
	}

	const managedEvents: Array<{
		eventName:
			| "SessionStart"
			| "SessionEnd"
			| "UserPromptSubmit"
			| "Stop"
			| "PostToolUse"
			| "PostToolUseFailure"
			| "PermissionRequest";
		definition: ClaudeHookDefinition;
	}> = [
		{
			eventName: "SessionStart",
			definition: { hooks: [{ type: "command", command: managedHookCommand }] },
		},
		{
			eventName: "SessionEnd",
			definition: { hooks: [{ type: "command", command: managedHookCommand }] },
		},
		{
			eventName: "UserPromptSubmit",
			definition: { hooks: [{ type: "command", command: managedHookCommand }] },
		},
		{
			eventName: "Stop",
			definition: { hooks: [{ type: "command", command: managedHookCommand }] },
		},
		{
			eventName: "PostToolUse",
			definition: {
				matcher: "*",
				hooks: [{ type: "command", command: managedHookCommand }],
			},
		},
		{
			eventName: "PostToolUseFailure",
			definition: {
				matcher: "*",
				hooks: [{ type: "command", command: managedHookCommand }],
			},
		},
		{
			eventName: "PermissionRequest",
			definition: {
				matcher: "*",
				hooks: [{ type: "command", command: managedHookCommand }],
			},
		},
	];

	for (const { eventName, definition } of managedEvents) {
		const current = existing.hooks[eventName];
		if (Array.isArray(current)) {
			const filtered = current.flatMap((def: ClaudeHookDefinition) => {
				const cleaned = removeManagedHooksFromDefinition(def, (command) =>
					isManagedClaudeHookCommand(command, notifyScriptPath),
				);
				return cleaned ? [cleaned] : [];
			});
			filtered.push(definition);
			existing.hooks[eventName] = filtered;
		} else {
			existing.hooks[eventName] = [definition];
		}
	}

	return JSON.stringify(existing, null, 2);
}

/**
 * Writes Superset hook definitions directly into ~/.claude/settings.json.
 * This ensures hooks work regardless of whether the binary wrapper is in PATH,
 * matching the approach used for Cursor, Gemini, Droid, and Mastra.
 */
export function createClaudeSettingsJson(): void {
	if (process.platform === "win32") {
		// Write the .cmd launcher (Git Bash → notify.sh) first; skip Claude
		// entirely if Git Bash isn't installed (the hook would dangle).
		if (!createClaudeWin32Launcher()) return;
	}
	const notifyScriptPath = getNotifyScriptPath();
	const globalPath = getClaudeGlobalSettingsJsonPath();
	const content = getClaudeGlobalSettingsJsonContent(notifyScriptPath);
	if (content === null) return;

	const dir = path.dirname(globalPath);
	fs.mkdirSync(dir, { recursive: true });
	const changed = writeFileIfChanged(globalPath, content, 0o644);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} Claude settings.json`,
	);
}

/**
 * Renders the OpenCode plugin file content with the current notify script path.
 */
export function getOpenCodePluginContent(notifyPath: string): string {
	const template = fs.readFileSync(OPENCODE_PLUGIN_TEMPLATE_PATH, "utf-8");
	return template
		.replace("{{MARKER}}", OPENCODE_PLUGIN_MARKER)
		.replace("{{NOTIFY_PATH}}", notifyPath);
}

/**
 * Pass-through wrapper for Claude. Hooks live in ~/.claude/settings.json
 * (createClaudeSettingsJson); the wrapper exists only to forward SUPERSET_*
 * env vars into the agent process tree.
 */
export function createClaudeWrapper(): void {
	const script = buildWrapperScript("claude", `exec "$REAL_BIN" "$@"`, {
		agentId: "claude",
	});
	createWrapper("claude", script);
}

/**
 * Creates the Codex wrapper that injects Superset's notify/session-log logic.
 */
export function createCodexWrapper(): void {
	const notifyPath = getNotifyScriptPath();
	const script = buildWrapperScript(
		"codex",
		buildCodexWrapperExecLine(notifyPath),
		{ agentId: "codex" },
	);
	createWrapper("codex", script);
}

/**
 * Builds the Codex wrapper exec block from the shell template.
 */
export function buildCodexWrapperExecLine(notifyPath: string): string {
	const template = fs.readFileSync(CODEX_WRAPPER_EXEC_TEMPLATE_PATH, "utf-8");
	return template.replaceAll("{{NOTIFY_PATH}}", notifyPath);
}

/**
 * Windows: the Codex .cmd launcher. Codex passes the hook JSON as argv (unlike
 * Claude's stdin), so the launcher forwards %* to notify.sh via Git Bash.
 */
const CODEX_WIN32_LAUNCHER_NAME = "codex-notify.cmd";
function getCodexWin32LauncherPath(): string {
	return path.join(HOOKS_DIR, CODEX_WIN32_LAUNCHER_NAME);
}

/** @see createClaudeWin32Launcher — same pattern, Codex agent id + %* forward. */
function createCodexWin32Launcher(): boolean {
	const bashPath = resolveAgentShellWin32();
	if (!/(^|[\\/])bash(\.exe)?$/i.test(bashPath)) {
		console.warn(
			"[agent-setup] Git Bash not found; cannot install Codex notify hook on Windows.",
		);
		return false;
	}
	const content = [
		"@echo off",
		"REM Superset Codex notify launcher (Windows). Runs notify.sh via Git Bash.",
		"REM Codex passes the hook JSON payload as argv; %* forwards it to notify.sh.",
		'set "SUPERSET_AGENT_ID=codex"',
		`"${bashPath}" "%~dp0${NOTIFY_SCRIPT_NAME}" %*`,
		"",
	].join("\r\n");
	const changed = writeFileIfChanged(
		getCodexWin32LauncherPath(),
		content,
		0o755,
	);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} Codex notify launcher (Windows)`,
	);
	return true;
}

/**
 * The command written into Codex's ~/.codex/hooks.json. Unix inlines
 * SUPERSET_AGENT_ID + the notify path; Windows points at the .cmd launcher
 * (Codex appends the JSON argv when it fires the hook).
 */
function getCodexManagedHookCommand(): string {
	if (process.platform === "win32") {
		return `"${getCodexWin32LauncherPath()}"`;
	}
	return `SUPERSET_AGENT_ID=codex "${getNotifyScriptPath()}"`;
}

function isManagedCodexHookCommand(
	command: string | undefined,
	notifyScriptPath: string,
): boolean {
	return (
		command?.includes(notifyScriptPath) ||
		(process.platform === "win32" &&
			command?.includes(getCodexWin32LauncherPath())) ||
		isSupersetManagedHookCommand(command, NOTIFY_SCRIPT_NAME)
	);
}

// ---------------------------------------------------------------------------
// Codex ~/.codex/hooks.json direct merge
// ---------------------------------------------------------------------------

/** Codex hooks.json uses the same nested structure as Claude/Droid settings.json */
type CodexHooksJson = ClaudeSettingsJson;

function readExistingCodexHooks(globalPath: string): CodexHooksJson | null {
	if (!fs.existsSync(globalPath)) {
		return {};
	}

	try {
		const parsed = JSON.parse(fs.readFileSync(globalPath, "utf-8"));
		if (!isPlainObject(parsed)) {
			console.warn(
				"[agent-setup] Expected ~/.codex/hooks.json to contain a JSON object; skipping Codex hook merge",
			);
			return null;
		}
		return parsed;
	} catch (error) {
		console.warn(
			"[agent-setup] Could not parse existing ~/.codex/hooks.json; skipping Codex hook merge:",
			error,
		);
		return null;
	}
}

/**
 * Returns the global Codex hooks.json path used for fallback hook registration.
 */
export function getCodexGlobalHooksJsonPath(): string {
	return path.join(os.homedir(), ".codex", "hooks.json");
}

/**
 * Reads existing ~/.codex/hooks.json, merges our hook definitions
 * (identified by notify script path), and preserves any user-defined hooks.
 *
 * Codex hooks.json uses the same nested structure as Claude/Droid:
 *   { hooks: { EventName: [{ matcher?, hooks: [{ type, command }] }] } }
 *
 * Superset uses native Codex hooks as the durable lifecycle integration path.
 * Recent Codex builds no longer emit the older session-log shapes our wrapper
 * watcher depended on, so we register prompt/tool lifecycle hooks directly in
 * ~/.codex/hooks.json and treat the wrapper session-log watcher as best-effort
 * compatibility for older releases.
 */
export function getCodexGlobalHooksJsonContent(
	notifyScriptPath: string,
): string | null {
	const globalPath = getCodexGlobalHooksJsonPath();
	const existing = readExistingCodexHooks(globalPath);
	if (!existing) return null;

	if (!existing.hooks || typeof existing.hooks !== "object") {
		existing.hooks = {};
	}

	// Remove all stale Superset-managed Codex hook commands, including events we
	// no longer manage natively (for example UserPromptSubmit from older builds).
	for (const [eventName, current] of Object.entries(existing.hooks)) {
		if (!Array.isArray(current)) continue;
		const filtered = current.flatMap((def: ClaudeHookDefinition) => {
			const cleaned = removeManagedHooksFromDefinition(def, (command) =>
				isManagedCodexHookCommand(command, notifyScriptPath),
			);
			return cleaned ? [cleaned] : [];
		});

		if (filtered.length === 0) {
			delete existing.hooks[eventName];
			continue;
		}

		existing.hooks[eventName] = filtered;
	}

	// Inline SUPERSET_AGENT_ID so the v2 payload carries identity even when codex
	// is launched outside the wrapper. Quote the path: codex executes via
	// /bin/sh -lc, so a space in $HOME (e.g. "/Users/Some User/...") would
	// otherwise word-split. On Windows this is the .cmd launcher path instead.
	const codexCommand = getCodexManagedHookCommand();

	const managedEvents: Array<{
		eventName: "SessionStart" | "UserPromptSubmit" | "Stop";
		definition: ClaudeHookDefinition;
	}> = [
		{
			eventName: "SessionStart",
			definition: { hooks: [{ type: "command", command: codexCommand }] },
		},
		{
			eventName: "UserPromptSubmit",
			definition: { hooks: [{ type: "command", command: codexCommand }] },
		},
		{
			eventName: "Stop",
			definition: { hooks: [{ type: "command", command: codexCommand }] },
		},
	];

	for (const { eventName, definition } of managedEvents) {
		const current = existing.hooks[eventName];
		if (Array.isArray(current)) {
			current.push(definition);
			existing.hooks[eventName] = current;
		} else {
			existing.hooks[eventName] = [definition];
		}
	}

	return JSON.stringify(existing, null, 2);
}

/**
 * Writes Superset hook definitions directly into ~/.codex/hooks.json.
 * This provides a fallback notification path that works even when the
 * binary wrapper is not in PATH (e.g. user runs codex from outside
 * a Superset terminal).
 *
 * The wrapper still injects Codex's native notify callback and keeps the
 * session-log watcher as a best-effort bridge for older releases, but the
 * native hooks.json registration is now the primary source for prompt/tool
 * lifecycle events.
 */
export function createCodexHooksJson(): void {
	if (process.platform === "win32") {
		// Write the .cmd launcher (Git Bash → notify.sh, forwarding Codex's argv
		// JSON) first; skip Codex if Git Bash isn't installed.
		if (!createCodexWin32Launcher()) return;
	}
	const notifyScriptPath = getNotifyScriptPath();
	const globalPath = getCodexGlobalHooksJsonPath();
	const content = getCodexGlobalHooksJsonContent(notifyScriptPath);
	if (content === null) return;

	const dir = path.dirname(globalPath);
	fs.mkdirSync(dir, { recursive: true });
	const changed = writeFileIfChanged(globalPath, content, 0o644);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} Codex hooks.json`,
	);
}

/**
 * Writes to environment-specific path only, NOT the global path.
 * Global path causes dev/prod conflicts when both are running.
 */
export function createOpenCodePlugin(): void {
	const pluginPath = getOpenCodePluginPath();
	const notifyPath = getNotifyScriptPath();
	const content = getOpenCodePluginContent(notifyPath);
	const changed = writeFileIfChanged(pluginPath, content, 0o644);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} OpenCode plugin`,
	);
}

/**
 * Removes stale global plugin written by older versions.
 * Only removes if the file contains our signature to avoid deleting user plugins.
 */
export function cleanupGlobalOpenCodePlugin(): void {
	try {
		const globalPluginPath = getOpenCodeGlobalPluginPath();
		if (!fs.existsSync(globalPluginPath)) return;

		const content = fs.readFileSync(globalPluginPath, "utf-8");
		if (content.includes(OPENCODE_PLUGIN_SIGNATURE)) {
			fs.unlinkSync(globalPluginPath);
			console.log(
				"[agent-setup] Removed stale global OpenCode plugin to prevent dev/prod conflicts",
			);
		}
	} catch (error) {
		console.warn(
			"[agent-setup] Failed to cleanup global OpenCode plugin:",
			error,
		);
	}
}

/**
 * Creates the OpenCode wrapper with an environment-scoped config directory.
 */
export function createOpenCodeWrapper(): void {
	const script = buildWrapperScript(
		"opencode",
		`export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR}"\nexec "$REAL_BIN" "$@"`,
		{ agentId: "opencode" },
	);
	createWrapper("opencode", script);
}
