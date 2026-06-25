import { spawnSync } from "node:child_process";

export interface ProcessInfo {
	pid: number;
	ppid: number;
	pgid: number;
}

export interface ProcessSignalError {
	target: "pid" | "pgid";
	id: number;
	signal: NodeJS.Signals;
	error: unknown;
}

export interface ProcessSignalTarget {
	target: "pid" | "pgid";
	id: number;
}

export interface SignalProcessTreeAndGroupsOptions {
	/**
	 * When false, skip the root pid and its process group. node-pty will
	 * deliver the signal to its own child separately; we only need to handle
	 * descendants and any detached process groups they spawned.
	 */
	includeRoot?: boolean;
	signalGroups?: boolean;
	signalPids?: boolean;
	excludeCurrentProcessGroup?: boolean;
	onSignalError?: (error: ProcessSignalError) => void;
}

export function signalProcessTreeAndGroups(
	rootPid: number,
	signal: NodeJS.Signals,
	options: SignalProcessTreeAndGroupsOptions = {},
): ProcessSignalTarget[] {
	// Windows has no process groups and no `ps`; the whole-tree semantics the
	// Unix path builds (enumerate via `ps`, signal each pid + each pgid) have
	// no native analog. `taskkill /T /F` force-kills the root and its entire
	// descendant tree in one kernel call, which is both simpler and the only
	// correct action. SIGTERM/SIGKILL distinction collapses to TerminateProcess
	// on Windows anyway, so there's nothing left to escalate — return no
	// targets (the escalation timers in the callers then no-op).
	if (process.platform === "win32") {
		signalProcessTreeWindows(rootPid, options.onSignalError);
		return [];
	}

	const targets = collectProcessSignalTargets(rootPid, options);
	signalProcessTargets(targets, signal, options.onSignalError);
	return targets;
}

/**
 * Upper bound on a single `taskkill` invocation. Normal tree teardown is
 * sub-second; anything past this means taskkill's tree-walk is hung on a
 * stubborn descendant (e.g. an agent TUI holding the console). We'd rather
 * kill the hung taskkill and fall back to a root-only TerminateProcess than
 * block the daemon's cleanup path indefinitely.
 */
const TASKKILL_TIMEOUT_MS = 7000;

/**
 * Windows: `taskkill /PID <pid> /T /F` terminates the process tree rooted at
 * `rootPid`. `/T` walks descendants, `/F` forces. Unlike the Unix path there
 * is no graceful-then-force escalation — TerminateProcess is unconditional —
 * so a single call is the whole job.
 *
 * Two hardening measures over the naive call:
 *  - A `timeout` on spawnSync, so a tree-walk hung on a stubborn descendant
 *    can't block the daemon's kill/cleanup path. When it fires, spawnSync
 *    kills the child taskkill and sets `result.error.code === "ETIMEDOUT"`.
 *  - A root-only fallback (`taskkill /PID <pid> /F`, no `/T`) that runs
 *    whenever the primary tree-kill didn't cleanly succeed. It's a fast
 *    kernel TerminateProcess on just the shell root, guaranteeing the root
 *    dies even when the tree-walk hung — which is what stops conhost.exe
 *    pseudo-console hosts from leaking.
 */
function signalProcessTreeWindows(
	rootPid: number,
	onSignalError?: (error: ProcessSignalError) => void,
): void {
	const primary = spawnSync("taskkill", ["/PID", String(rootPid), "/T", "/F"], {
		encoding: "utf8",
		windowsHide: true,
		timeout: TASKKILL_TIMEOUT_MS,
	});

	const primaryStderr = (primary.stderr ?? "").trim();
	const timedOut =
		primary.error instanceof Error &&
		(primary.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
	// taskkill prints "ERROR: ... timeout period expired" when IT gives up
	// mid-teardown (distinct from our spawnSync timeout). That's taskkill
	// bailing on a descendant, not a real failure — best-effort, not scary.
	const taskkillGaveUp = primaryStderr
		.toLowerCase()
		.includes("timeout period expired");
	const alreadyDead =
		primaryStderr.includes("not found") ||
		primaryStderr.includes("no running instance");
	const primaryOk = primary.status === 0 || alreadyDead;

	// "timeout period expired" is expected during teardown of a stubborn tree;
	// log it but never surface it through onSignalError.
	if (taskkillGaveUp) {
		console.warn(
			`[pty-daemon] taskkill tree-kill gave up on pid ${rootPid} (best-effort): ${primaryStderr}`,
		);
	}

	if (!primaryOk && !timedOut && !taskkillGaveUp) {
		// Genuinely unexpected failure — surface for diagnostics.
		onSignalError?.({
			target: "pid",
			id: rootPid,
			signal: "SIGKILL",
			error:
				primary.error ??
				new Error(`taskkill exit ${primary.status}: ${primaryStderr}`),
		});
	}

	// Fallback: if the tree-kill timed out, gave up, or otherwise failed to
	// cleanly finish, force-kill JUST the root. This is a fast TerminateProcess
	// with no descendant walk, so it can't hang. It's what actually tears down
	// the shell root (and with it the conhost pseudo-console host) when the
	// tree-walk got stuck on a descendant.
	if (!primaryOk || timedOut || taskkillGaveUp) {
		rootOnlyForceKill(rootPid, onSignalError, {
			skipIfAlreadyDead: alreadyDead,
		});
	}
}

/**
 * `taskkill /PID <pid> /F` — TerminateProcess on just the root, no `/T`
 * tree-walk. Fast and unhangable. Best-effort: an "already dead" result here
 * is success (the root is gone, which is all we can guarantee); anything else
 * is surfaced so we don't silently lose the kill.
 */
function rootOnlyForceKill(
	rootPid: number,
	onSignalError?: (error: ProcessSignalError) => void,
	opts: { skipIfAlreadyDead?: boolean } = {},
): void {
	const result = spawnSync("taskkill", ["/PID", String(rootPid), "/F"], {
		encoding: "utf8",
		windowsHide: true,
		timeout: TASKKILL_TIMEOUT_MS,
	});
	if (result.status === 0) return;

	const stderr = (result.stderr ?? "").trim();
	const alreadyDead =
		stderr.includes("not found") || stderr.includes("no running instance");
	// If the primary already reported the root dead, an "already dead" echo
	// here is expected and not worth logging again.
	if (alreadyDead && opts.skipIfAlreadyDead) return;
	if (alreadyDead) return;

	onSignalError?.({
		target: "pid",
		id: rootPid,
		signal: "SIGKILL",
		error:
			result.error ??
			new Error(`taskkill root-only exit ${result.status}: ${stderr}`),
	});
}

export function collectProcessSignalTargets(
	rootPid: number,
	options: SignalProcessTreeAndGroupsOptions = {},
): ProcessSignalTarget[] {
	if (!isPositiveInteger(rootPid)) return [];

	const includeRoot = options.includeRoot ?? true;
	const signalGroups = options.signalGroups ?? true;
	const signalPids = options.signalPids ?? true;
	const excludeCurrentProcessGroup = options.excludeCurrentProcessGroup ?? true;
	const table = readProcessTable();
	const currentPgid = excludeCurrentProcessGroup
		? getProcessGroupId(process.pid, table)
		: null;
	const rootPgid = getProcessGroupId(rootPid, table);
	const pids = collectProcessTree(rootPid, table);
	const infoByPid = new Map(table.map((row) => [row.pid, row]));
	const pgids = new Set<number>();
	const targets: ProcessSignalTarget[] = [];

	for (const pid of pids) {
		if (!includeRoot && pid === rootPid) continue;
		const info = infoByPid.get(pid);
		if (!info) continue;
		if (info.pgid <= 1) continue;
		if (currentPgid !== null && info.pgid === currentPgid) continue;
		if (!includeRoot && rootPgid !== null && info.pgid === rootPgid) {
			continue;
		}
		pgids.add(info.pgid);
	}

	if (signalGroups) {
		for (const pgid of pgids) {
			targets.push({ target: "pgid", id: pgid });
		}
	}

	if (signalPids) {
		for (const pid of pids) {
			if (!includeRoot && pid === rootPid) continue;
			targets.push({ target: "pid", id: pid });
		}
	}

	return targets;
}

export function signalProcessTargets(
	targets: ProcessSignalTarget[],
	signal: NodeJS.Signals,
	onSignalError?: (error: ProcessSignalError) => void,
): void {
	for (const { target, id } of targets) {
		signalTarget(target, id, signal, onSignalError);
	}
}

export function readProcessTable(): ProcessInfo[] {
	const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid="], {
		encoding: "utf8",
	});
	if (result.error || result.status !== 0) return [];

	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			const [pidText, ppidText, pgidText] = line.split(/\s+/);
			if (
				pidText === undefined ||
				ppidText === undefined ||
				pgidText === undefined
			) {
				return [];
			}
			const pid = Number(pidText);
			const ppid = Number(ppidText);
			const pgid = Number(pgidText);
			if (!isPositiveInteger(pid) || !Number.isInteger(ppid) || ppid < 0) {
				return [];
			}
			if (!isPositiveInteger(pgid)) return [];
			return [{ pid, ppid, pgid }];
		});
}

export function collectProcessTree(
	rootPid: number,
	table: ProcessInfo[],
): Set<number> {
	const pids = new Set<number>([rootPid]);
	const childrenByParent = new Map<number, ProcessInfo[]>();
	for (const row of table) {
		const children = childrenByParent.get(row.ppid) ?? [];
		children.push(row);
		childrenByParent.set(row.ppid, children);
	}

	const queue = [rootPid];
	for (const pid of queue) {
		for (const child of childrenByParent.get(pid) ?? []) {
			if (pids.has(child.pid)) continue;
			pids.add(child.pid);
			queue.push(child.pid);
		}
	}

	return pids;
}

export function getProcessGroupId(
	pid: number,
	table: ProcessInfo[],
): number | null {
	return table.find((row) => row.pid === pid)?.pgid ?? null;
}

export function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function signalTarget(
	target: "pid" | "pgid",
	id: number,
	signal: NodeJS.Signals,
	onSignalError: SignalProcessTreeAndGroupsOptions["onSignalError"],
): void {
	try {
		process.kill(target === "pgid" ? -id : id, signal);
	} catch (error) {
		onSignalError?.({ target, id, signal, error });
	}
}
