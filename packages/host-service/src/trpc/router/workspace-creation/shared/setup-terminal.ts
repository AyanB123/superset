import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { projects, workspaces } from "../../../../db/schema";
import {
	getResolvedSetupCommands,
	loadSetupConfig,
} from "../../../../runtime/setup/config";
import { createTerminalSessionInternal } from "../../../../terminal/terminal";
import type { HostServiceContext } from "../../../../types";
import type { TerminalDescriptor } from "./types";

interface StartSetupTerminalArgs {
	ctx: HostServiceContext;
	workspaceId: string;
}

interface StartSetupTerminalResult {
	terminal: TerminalDescriptor | null;
	warning: string | null;
}

/**
 * Resolve and start the workspace-creation setup terminal, if any.
 *
 * Source order:
 *   1. Configured `setup` array from `.superset/config.json` (+ user override
 *      and `config.local.json` overlay) — joined with ` && ` so failures
 *      short-circuit.
 *   2. Fallback: `bash <repoPath>/.superset/setup.sh` against the main repo
 *      (NOT the worktree — worktrees skip gitignored files, the main repo is
 *      authoritative). Scripts that need the canonical `.superset/` dir read
 *      `$SUPERSET_ROOT_PATH`, injected by the v2 terminal env builder.
 *
 *   On Windows the bash fallback is intentionally NOT used (bash is often
 *   absent and sh scripts may not run cleanly). Instead, if the repo ships a
 *   `.superset/setup.ps1` it is run via PowerShell; otherwise the setup step
 *   is skipped cleanly (no terminal is created).
 *
 * No-op when neither source resolves to anything runnable.
 */
export async function startSetupTerminalIfPresent(
	args: StartSetupTerminalArgs,
): Promise<StartSetupTerminalResult> {
	const row = args.ctx.db
		.select({
			worktreePath: workspaces.worktreePath,
			repoPath: projects.repoPath,
			projectId: workspaces.projectId,
		})
		.from(workspaces)
		.innerJoin(projects, eq(projects.id, workspaces.projectId))
		.where(eq(workspaces.id, args.workspaceId))
		.get();

	if (!row || !row.worktreePath || !row.repoPath) {
		return { terminal: null, warning: null };
	}

	const initialCommand = resolveInitialCommand({
		repoPath: row.repoPath,
		projectId: row.projectId,
	});
	if (!initialCommand) {
		return { terminal: null, warning: null };
	}

	const terminalId = crypto.randomUUID();
	const result = await createTerminalSessionInternal({
		terminalId,
		workspaceId: args.workspaceId,
		db: args.ctx.db,
		eventBus: args.ctx.eventBus,
		initialCommand,
	});
	if ("error" in result) {
		return {
			terminal: null,
			warning: `Failed to start setup terminal: ${result.error}`,
		};
	}

	return {
		terminal: {
			id: terminalId,
			role: "setup",
			label: "Workspace Setup",
		},
		warning: null,
	};
}

/** Exported for tests. Resolves the initial command for the setup terminal. */
export function resolveInitialCommand(args: {
	repoPath: string;
	projectId: string;
	/** Override $HOME for tests. */
	homeDir?: string;
}): string | null {
	const config = loadSetupConfig(args);
	const commands = getResolvedSetupCommands(config);
	if (commands.length > 0) {
		return commands.join(" && ");
	}

	if (process.platform === "win32") {
		// Windows: prefer a `.ps1` setup script (bash may be unavailable and
		// sh scripts can't be relied on). If no `.ps1` is present, skip the
		// setup step cleanly rather than attempting to run a `.sh`.
		const ps1Script = join(args.repoPath, ".superset", "setup.ps1");
		if (existsSync(ps1Script)) {
			return `powershell -NoProfile -ExecutionPolicy Bypass -File ${psQuote(ps1Script)}`;
		}
		return null;
	}

	const fallbackScript = join(args.repoPath, ".superset", "setup.sh");
	if (existsSync(fallbackScript)) {
		return `bash ${singleQuote(fallbackScript)}`;
	}

	return null;
}

/** POSIX single-quote escape: safe for any path passed through a shell. */
function singleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * PowerShell-safe single-quote escape. PowerShell single-quoted strings treat
 * every character literally except a single quote itself, which is doubled.
 * Used for `-File <path>` where the path must survive the cmd → powershell
 * handoff intact (e.g. paths with spaces).
 */
function psQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
