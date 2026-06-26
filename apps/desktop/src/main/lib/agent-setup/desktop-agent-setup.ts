import {
	cleanupGlobalOpenCodePlugin,
	createAmpPlugin,
	createAmpWrapper,
	createClaudeSettingsJson,
	createClaudeWrapper,
	createCodexHooksJson,
	createCodexWrapper,
	createCopilotHookScript,
	createCopilotWrapper,
	createCursorAgentWrapper,
	createCursorHookScript,
	createCursorHooksJson,
	createDroidSettingsJson,
	createDroidWrapper,
	createGeminiHookScript,
	createGeminiSettingsJson,
	createGeminiWrapper,
	createMastraHooksJson,
	createMastraWrapper,
	createOpenCodePlugin,
	createOpenCodeWrapper,
	createPiExtension,
} from "./agent-wrappers";
import {
	DESKTOP_AGENT_SETUP_BOOTSTRAP_ACTIONS,
	DESKTOP_AGENT_SETUP_TARGETS,
	type DesktopAgentSetupAction,
} from "./desktop-agent-capabilities";
import { createNotifyScript } from "./notify-hook";

const DESKTOP_AGENT_SETUP_RUNNERS: Record<DesktopAgentSetupAction, () => void> =
	{
		"notify-script": createNotifyScript,
		"cleanup-global-opencode-plugin": cleanupGlobalOpenCodePlugin,
		"amp-plugin": createAmpPlugin,
		"amp-wrapper": createAmpWrapper,
		"claude-settings-json": createClaudeSettingsJson,
		"claude-wrapper": createClaudeWrapper,
		"codex-hooks-json": createCodexHooksJson,
		"codex-wrapper": createCodexWrapper,
		"droid-wrapper": createDroidWrapper,
		"droid-settings-json": createDroidSettingsJson,
		"opencode-plugin": createOpenCodePlugin,
		"opencode-wrapper": createOpenCodeWrapper,
		"pi-extension": createPiExtension,
		"cursor-hook-script": createCursorHookScript,
		"cursor-agent-wrapper": createCursorAgentWrapper,
		"cursor-hooks-json": createCursorHooksJson,
		"gemini-hook-script": createGeminiHookScript,
		"gemini-wrapper": createGeminiWrapper,
		"gemini-settings-json": createGeminiSettingsJson,
		"mastra-wrapper": createMastraWrapper,
		"mastra-hooks-json": createMastraHooksJson,
		"copilot-hook-script": createCopilotHookScript,
		"copilot-wrapper": createCopilotWrapper,
	};

export function setupDesktopAgentCapabilities(opts?: {
	windowsOnly?: boolean;
}): void {
	for (const action of DESKTOP_AGENT_SETUP_BOOTSTRAP_ACTIONS) {
		DESKTOP_AGENT_SETUP_RUNNERS[action]();
	}

	for (const target of DESKTOP_AGENT_SETUP_TARGETS) {
		// On Windows only run the agent's ported windowsSetupActions; on Unix run
		// the full setupActions. Agents without windowsSetupActions are skipped.
		const actions = opts?.windowsOnly
			? target.windowsSetupActions
			: target.setupActions;
		if (!actions) continue;
		for (const action of actions) {
			DESKTOP_AGENT_SETUP_RUNNERS[action]();
		}
	}
}

/**
 * Re-run setupActions for one agent. Bootstrap actions run first because
 * per-agent hooks reference the shared notify script — without them the
 * per-agent setup isn't self-sufficient. Returns `false` for unknown ids, and
 * on win32 for agents without ported `windowsSetupActions`. Callers (the
 * settings UI "Add agent" safety net) treat `false` as "did not run", so no
 * half-installed hooks are left behind.
 */
export function setupSingleAgent(agentId: string): boolean {
	const target = DESKTOP_AGENT_SETUP_TARGETS.find((t) => t.id === agentId);
	if (!target) return false;
	const windowsOnly = process.platform === "win32";
	const actions = windowsOnly
		? target.windowsSetupActions
		: target.setupActions;
	if (!actions || actions.length === 0) {
		if (windowsOnly) {
			console.log(
				`[agent-setup] Agent "${agentId}" hooks are not yet supported on Windows; skipping.`,
			);
		}
		return false;
	}
	for (const action of DESKTOP_AGENT_SETUP_BOOTSTRAP_ACTIONS) {
		DESKTOP_AGENT_SETUP_RUNNERS[action]();
	}
	for (const action of actions) {
		DESKTOP_AGENT_SETUP_RUNNERS[action]();
	}
	return true;
}
