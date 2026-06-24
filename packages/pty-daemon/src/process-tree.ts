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
 * Windows: `taskkill /PID <pid> /T /F` terminates the process tree rooted at
 * `rootPid`. `/T` walks descendants, `/F` forces. Unlike the Unix path there
 * is no graceful-then-force escalation — TerminateProcess is unconditional —
 * so a single call is the whole job.
 */
function signalProcessTreeWindows(
	rootPid: number,
	onSignalError?: (error: ProcessSignalError) => void,
): void {
	const result = spawnSync("taskkill", ["/PID", String(rootPid), "/T", "/F"], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.error || result.status !== 0) {
		// 128 = "no such process" (already dead) — treat as success, like the
		// Unix path's ESRCH swallow in Pty.ts. Any other nonzero surfaces to
		// the caller's onSignalError for diagnostics.
		const stderr = (result.stderr ?? "").trim();
		const alreadyDead =
			stderr.includes("not found") || stderr.includes("no running instance");
		if (!alreadyDead) {
			onSignalError?.({
				target: "pid",
				id: rootPid,
				signal: "SIGKILL",
				error:
					result.error ??
					new Error(`taskkill exit ${result.status}: ${stderr}`),
			});
		}
	}
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
