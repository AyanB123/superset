import fs from "node:fs";
import path from "node:path";
import { env } from "shared/env.shared";
import {
	buildWrapperScript,
	createWrapper,
	writeFileIfChanged,
} from "./agent-wrappers-common";
import { HOOKS_DIR } from "./paths";

export const COPILOT_HOOK_SCRIPT_NAME = "copilot-hook.sh";

const COPILOT_HOOK_SIGNATURE = "# Superset copilot hook";
const COPILOT_HOOK_VERSION = "v2";
export const COPILOT_HOOK_MARKER = `${COPILOT_HOOK_SIGNATURE} ${COPILOT_HOOK_VERSION}`;

const COPILOT_HOOK_TEMPLATE_PATH = path.join(
	__dirname,
	"templates",
	"copilot-hook.template.sh",
);

export function getCopilotHookScriptPath(): string {
	return path.join(HOOKS_DIR, COPILOT_HOOK_SCRIPT_NAME);
}

export function getCopilotHookScriptContent(): string {
	const template = fs.readFileSync(COPILOT_HOOK_TEMPLATE_PATH, "utf-8");
	return template
		.replace("{{MARKER}}", COPILOT_HOOK_MARKER)
		.replaceAll("{{DEFAULT_PORT}}", String(env.DESKTOP_NOTIFICATIONS_PORT));
}

export function createCopilotHookScript(): void {
	const scriptPath = getCopilotHookScriptPath();
	const content = getCopilotHookScriptContent();
	const changed = writeFileIfChanged(scriptPath, content, 0o755);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} Copilot hook script`,
	);
}

export function getCopilotHooksJsonContent(hookScriptPath: string): string {
	const hooks = {
		version: 1,
		hooks: {
			sessionStart: [
				{
					type: "command",
					bash: `${hookScriptPath} sessionStart`,
					timeoutSec: 5,
				},
			],
			sessionEnd: [
				{
					type: "command",
					bash: `${hookScriptPath} sessionEnd`,
					timeoutSec: 5,
				},
			],
			userPromptSubmitted: [
				{
					type: "command",
					bash: `${hookScriptPath} userPromptSubmitted`,
					timeoutSec: 5,
				},
			],
			postToolUse: [
				{
					type: "command",
					bash: `${hookScriptPath} postToolUse`,
					timeoutSec: 5,
				},
			],
		},
	};
	return JSON.stringify(hooks, null, 2);
}

export function buildCopilotWrapperExecLine(): string {
	const hookScriptPath = getCopilotHookScriptPath();
	const hooksJson = getCopilotHooksJsonContent(hookScriptPath);
	const escapedJson = hooksJson.replace(/'/g, "'\\''");

	// NOTE: this wrapper is Unix-only — it's a bash script that injects a
	// project-level .github/hooks/superset-notify.json into the CWD at runtime.
	// Copilot CLI's hook mechanism on Windows can't be mirrored the same way:
	// (1) the bash wrapper doesn't run under cmd/PowerShell, and (2) per-CWD
	// injection needs a POSIX shell. Copilot CLI does support global user-level
	// hooks (~/.copilot/hooks/*.json) as of its Feb 2026 GA, but adopting those
	// would be a cross-platform behavior change (not a Windows-only mirror of
	// the existing project-level path) and is out of scope for this port. See
	// desktop-agent-capabilities.ts — copilot has NO windowsSetupActions, so
	// setupSingleAgent() skips it cleanly on win32.
	return `# Copilot CLI only supports project-level hooks (.github/hooks/*.json in CWD).
# Auto-inject Superset notification hooks when running inside a v2 Superset terminal.
if [ -n "$SUPERSET_TERMINAL_ID" ] && [ -f "${hookScriptPath}" ]; then
  COPILOT_HOOKS_DIR=".github/hooks"
  COPILOT_HOOK_FILE="$COPILOT_HOOKS_DIR/superset-notify.json"

  # Always refresh our dedicated hook file so stale absolute hook paths from
  # older installs/workspaces cannot silently break notifications.
  mkdir -p "$COPILOT_HOOKS_DIR" 2>/dev/null
  printf '%s\\n' '${escapedJson}' > "$COPILOT_HOOK_FILE" 2>/dev/null

  if [ -d ".git/info" ]; then
    grep -qF ".github/hooks/superset-notify.json" ".git/info/exclude" 2>/dev/null || \\
      printf '%s\\n' ".github/hooks/superset-notify.json" >> ".git/info/exclude" 2>/dev/null
  fi
fi

exec "$REAL_BIN" "$@"`;
}

export function createCopilotWrapper(): void {
	const script = buildWrapperScript("copilot", buildCopilotWrapperExecLine(), {
		agentId: "copilot",
	});
	createWrapper("copilot", script);
}
