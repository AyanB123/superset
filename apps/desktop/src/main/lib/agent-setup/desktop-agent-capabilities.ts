import type { AgentType } from "@superset/shared/agent-command";

export type SupersetManagedBinary = AgentType;

export const DESKTOP_AGENT_SETUP_ACTIONS = [
	"notify-script",
	"cleanup-global-opencode-plugin",
	"amp-plugin",
	"amp-wrapper",
	"claude-settings-json",
	"claude-wrapper",
	"codex-hooks-json",
	"codex-wrapper",
	"droid-wrapper",
	"droid-settings-json",
	"opencode-plugin",
	"opencode-wrapper",
	"pi-extension",
	"cursor-hook-script",
	"cursor-agent-wrapper",
	"cursor-hooks-json",
	"gemini-hook-script",
	"gemini-wrapper",
	"gemini-settings-json",
	"mastra-wrapper",
	"mastra-hooks-json",
	"copilot-hook-script",
	"copilot-wrapper",
] as const;

export type DesktopAgentSetupAction =
	(typeof DESKTOP_AGENT_SETUP_ACTIONS)[number];

interface DesktopAgentSetupTarget {
	id: AgentType;
	setupActions: readonly DesktopAgentSetupAction[];
	/**
	 * Actions to run on Windows. Omit (or empty) for agents whose hooks aren't
	 * ported yet — {@link setupAgentHooks} skips them on win32. The Unix
	 * `setupActions` (bash wrappers, zsh/bash RC integration) don't apply on
	 * Windows; instead each ported agent installs a Windows-compatible hook
	 * (e.g. Claude merges into ~/.claude/settings.json pointing at a .cmd
	 * launcher that runs notify.sh via Git Bash).
	 */
	windowsSetupActions?: readonly DesktopAgentSetupAction[];
	managedBinary?: boolean;
}

export const DESKTOP_AGENT_SETUP_BOOTSTRAP_ACTIONS = [
	"cleanup-global-opencode-plugin",
	"notify-script",
] as const satisfies readonly DesktopAgentSetupAction[];

export const DESKTOP_AGENT_SETUP_TARGETS: readonly DesktopAgentSetupTarget[] = [
	{
		id: "amp",
		setupActions: ["amp-plugin", "amp-wrapper"],
		managedBinary: true,
	},
	{
		id: "claude",
		setupActions: ["claude-settings-json", "claude-wrapper"],
		// Windows: hooks live in ~/.claude/settings.json (no bash wrapper needed
		// for the primary path — Claude inherits SUPERSET_* env from the Superset
		// terminal). createClaudeSettingsJson writes a claude-notify.cmd launcher
		// (Git Bash → notify.sh) + points the hook at it.
		windowsSetupActions: ["claude-settings-json"],
		managedBinary: true,
	},
	{
		id: "codex",
		setupActions: ["codex-hooks-json", "codex-wrapper"],
		// Windows: hooks live in ~/.codex/hooks.json (the bash wrapper is skipped —
		// Codex inherits SUPERSET_* env from the terminal). createCodexHooksJson
		// writes a codex-notify.cmd launcher that forwards Codex's argv JSON to
		// notify.sh via Git Bash.
		windowsSetupActions: ["codex-hooks-json"],
		managedBinary: true,
	},
	{
		id: "droid",
		setupActions: ["droid-wrapper", "droid-settings-json"],
		managedBinary: true,
	},
	{
		id: "opencode",
		setupActions: ["opencode-plugin", "opencode-wrapper"],
		managedBinary: true,
	},
	{
		id: "pi",
		setupActions: ["pi-extension"],
	},
	{
		id: "cursor-agent",
		setupActions: [
			"cursor-hook-script",
			"cursor-agent-wrapper",
			"cursor-hooks-json",
		],
		// Windows: hooks live in ~/.cursor/hooks.json (the bash wrapper is
		// skipped — Cursor inherits SUPERSET_* env from the terminal).
		// createCursorHooksJson writes a cursor-notify.cmd launcher that runs
		// cursor-hook.sh via Git Bash, forwarding stdin + the event-name argv
		// (%*) and passing the auto-approve stdout JSON back to Cursor. The hook
		// script itself is also written (the launcher execs it).
		windowsSetupActions: ["cursor-hook-script", "cursor-hooks-json"],
	},
	{
		id: "gemini",
		setupActions: [
			"gemini-hook-script",
			"gemini-wrapper",
			"gemini-settings-json",
		],
		// Windows: hooks live in ~/.gemini/settings.json (the bash wrapper is
		// skipped — Gemini inherits SUPERSET_* env from the terminal).
		// createGeminiSettingsJson writes a gemini-notify.cmd launcher that runs
		// gemini-hook.sh via Git Bash, forwarding stdin and the required `{}`
		// stdout JSON back to Gemini. The hook script itself is also written.
		windowsSetupActions: ["gemini-hook-script", "gemini-settings-json"],
		managedBinary: true,
	},
	{
		id: "mastracode",
		setupActions: ["mastra-wrapper", "mastra-hooks-json"],
		managedBinary: true,
	},
	{
		id: "copilot",
		setupActions: ["copilot-hook-script", "copilot-wrapper"],
		// Windows: SKIPPED. Copilot's existing integration is project-level only
		// — a bash wrapper that writes .github/hooks/superset-notify.json into
		// the CWD at runtime. That wrapper can't run under cmd/PowerShell, and
		// the per-CWD injection needs a POSIX shell. Copilot CLI does support
		// global user-level hooks (~/.copilot/hooks/*.json) as of its Feb 2026
		// GA, but adopting those would be a cross-platform behavior change (not
		// a Windows-only mirror of the project-level path), so it's out of scope
		// here. No windowsSetupActions → setupSingleAgent() skips it on win32.
		managedBinary: true,
	},
];

// The type annotation on DESKTOP_AGENT_SETUP_TARGETS (not `as const`) widens the
// element types so the optional windowsSetupActions is accessible on every
// target; each setupActions tuple is still validated against
// DesktopAgentSetupAction via the contextual type.

/**
 * Agent ids whose bootstrap hooks are ported to Windows — derived from each
 * target's {@link DesktopAgentSetupTarget.windowsSetupActions}. An agent opts
 * into Windows by listing the actions that install its Windows-compatible hook
 * (e.g. Claude's `claude-settings-json`). {@link setupAgentHooks} runs only
 * these agents' Windows actions on win32; unported agents are skipped.
 */
export const WINDOWS_SUPPORTED_AGENT_SETUP_TARGET_IDS: readonly AgentType[] =
	DESKTOP_AGENT_SETUP_TARGETS.filter(
		(target) =>
			target.windowsSetupActions && target.windowsSetupActions.length > 0,
	).map((target) => target.id);

export const SUPERSET_MANAGED_BINARIES = DESKTOP_AGENT_SETUP_TARGETS.filter(
	(target) => "managedBinary" in target && target.managedBinary,
).map((target) => target.id) satisfies SupersetManagedBinary[];
