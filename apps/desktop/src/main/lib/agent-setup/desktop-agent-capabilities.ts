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
	managedBinary?: boolean;
}

export const DESKTOP_AGENT_SETUP_BOOTSTRAP_ACTIONS = [
	"cleanup-global-opencode-plugin",
	"notify-script",
] as const satisfies readonly DesktopAgentSetupAction[];

export const DESKTOP_AGENT_SETUP_TARGETS = [
	{
		id: "amp",
		setupActions: ["amp-plugin", "amp-wrapper"],
		managedBinary: true,
	},
	{
		id: "claude",
		setupActions: ["claude-settings-json", "claude-wrapper"],
		managedBinary: true,
	},
	{
		id: "codex",
		setupActions: ["codex-hooks-json", "codex-wrapper"],
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
	},
	{
		id: "gemini",
		setupActions: [
			"gemini-hook-script",
			"gemini-wrapper",
			"gemini-settings-json",
		],
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
		managedBinary: true,
	},
] as const satisfies readonly DesktopAgentSetupTarget[];

/**
 * Agent ids whose bootstrap hooks currently work on Windows. Every entry in
 * {@link DESKTOP_AGENT_SETUP_TARGETS} ships a `#!/bin/bash` notify/hook script
 * plus a bash binary wrapper and (for managed binaries) zsh/bash PATH shell
 * integration — none of which function on Windows yet. So until the Wave 2
 * shell resolver + per-agent Windows hook specs land, this set is empty and
 * {@link setupAgentHooks} skips installation entirely on win32. Adding an id
 * here once its hooks are ported re-enables it for Windows automatically.
 */
export const WINDOWS_SUPPORTED_AGENT_SETUP_TARGET_IDS: readonly AgentType[] =
	[];

export const SUPERSET_MANAGED_BINARIES = DESKTOP_AGENT_SETUP_TARGETS.filter(
	(target) => "managedBinary" in target && target.managedBinary,
).map((target) => target.id) satisfies SupersetManagedBinary[];
