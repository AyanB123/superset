import fs from "node:fs";
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
 * Agent bootstrap hooks are Unix-only today: the notify/hook scripts are
 * `#!/bin/bash` (grep/tr/date/curl), every binary wrapper is a bash
 * `find_real_binary` shim, and shell integration writes zsh/bash RC files.
 * Installing them on Windows would half-install (notify script present, but no
 * PATH wrapper and no shell integration to propagate SUPERSET_* env into the
 * agent process tree), so on win32 we skip the whole bootstrap and surface the
 * gap in logs. Windows support is tracked under plans/windows-native-support.md
 * (Wave 2: dual PowerShell/bash shell resolver + per-agent Windows hook specs).
 */
export const AGENT_SETUP_SUPPORTED_ON_THIS_PLATFORM =
	process.platform !== "win32";

export function setupAgentHooks(): void {
	if (!AGENT_SETUP_SUPPORTED_ON_THIS_PLATFORM) {
		console.log(
			"[agent-setup] Agent bootstrap hooks are not yet supported on Windows; skipping installation. " +
				"See plans/windows-native-support.md (Wave 2).",
		);
		return;
	}

	console.log("[agent-setup] Initializing agent hooks...");

	fs.mkdirSync(BIN_DIR, { recursive: true });
	fs.mkdirSync(HOOKS_DIR, { recursive: true });
	fs.mkdirSync(ZSH_DIR, { recursive: true });
	fs.mkdirSync(BASH_DIR, { recursive: true });
	fs.mkdirSync(OPENCODE_PLUGIN_DIR, { recursive: true });

	setupDesktopAgentCapabilities();

	createZshWrapper();
	createBashWrapper();

	console.log("[agent-setup] Agent hooks initialized");
}

export function getSupersetBinDir(): string {
	return BIN_DIR;
}

export { setupSingleAgent };

export { getCommandShellArgs, getShellArgs, getShellEnv };
