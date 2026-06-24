import fs from "node:fs";
import { WINDOWS_SUPPORTED_AGENT_SETUP_TARGET_IDS } from "./desktop-agent-capabilities";
import {
	setupDesktopAgentCapabilities,
	setupSingleAgent,
} from "./desktop-agent-setup";
import {
	BASH_DIR,
	BIN_DIR,
	HOOKS_DIR,
	OPENCODE_PLUGIN_DIR,
	ZSH_DIR,
} from "./paths";
import {
	createBashWrapper,
	createZshWrapper,
	getCommandShellArgs,
	getShellArgs,
	getShellEnv,
} from "./shell-wrappers";

/**
 * On Unix the full bootstrap runs: bash/zsh wrappers + shell-integration +
 * per-agent hook scripts. On Windows only agents with ported
 * `windowsSetupActions` run (notify.sh is Git-Bash-compatible; each ported
 * agent installs a Windows hook — e.g. Claude merges into ~/.claude/settings.json
 * pointing at a .cmd launcher that runs notify.sh via Git Bash). The bash
 * wrappers / zsh/bash RC integration are Unix-only and skipped on win32; for
 * the primary path (agent launched inside a Superset terminal) SUPERSET_* env
 * is inherited from the terminal, so the wrapper isn't required.
 */
export const AGENT_SETUP_SUPPORTED_ON_THIS_PLATFORM =
	process.platform !== "win32" ||
	WINDOWS_SUPPORTED_AGENT_SETUP_TARGET_IDS.length > 0;

export function setupAgentHooks(): void {
	if (!AGENT_SETUP_SUPPORTED_ON_THIS_PLATFORM) {
		console.log(
			"[agent-setup] No agent bootstrap hooks are supported on this platform; skipping installation.",
		);
		return;
	}

	const win32 = process.platform === "win32";
	console.log("[agent-setup] Initializing agent hooks...");

	fs.mkdirSync(HOOKS_DIR, { recursive: true });
	fs.mkdirSync(OPENCODE_PLUGIN_DIR, { recursive: true });
	if (!win32) {
		fs.mkdirSync(BIN_DIR, { recursive: true });
		fs.mkdirSync(ZSH_DIR, { recursive: true });
		fs.mkdirSync(BASH_DIR, { recursive: true });
	}

	setupDesktopAgentCapabilities({ windowsOnly: win32 });

	if (!win32) {
		createZshWrapper();
		createBashWrapper();
	}

	console.log("[agent-setup] Agent hooks initialized");
}

export function getSupersetBinDir(): string {
	return BIN_DIR;
}

export { setupSingleAgent };

export { getCommandShellArgs, getShellArgs, getShellEnv };
