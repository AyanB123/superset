/**
 * Cross-platform dev launcher for the electric-proxy Cloudflare Worker.
 *
 * Runs `wrangler dev` (the faithful local Workers runtime) on every platform.
 * The only Windows-specific concern: Hyper-V / WSL2 / Docker reserve dynamic
 * TCP port ranges (`netsh int ipv4 show excludedportrange protocol=tcp`), and
 * the default dev port (8787) frequently lands inside one — binding then fails
 * with a misleading error (bun/node: `EADDRINUSE`; workerd: `std::terminate` /
 * "Workers runtime failed to start"). So on Windows we detect excluded ranges
 * and in-use ports and, if the desired port is unavailable, pick the next usable
 * port and print it loudly so the client / Caddy can follow.
 *
 * Mirrors the original script (`dotenv -e ../../.env -- wrangler dev`) by loading
 * the root .env (WRANGLER_PORT etc.) before spawning wrangler.
 */
import { spawn, spawnSync } from "node:child_process";
import { loadEnvFile } from "./dotenv-lite";

loadEnvFile(new URL("../../.env", import.meta.url));

const desiredPort = Number(process.env.WRANGLER_PORT ?? "8787");

/** Parse `netsh int ipv4 show excludedportrange protocol=tcp` into [start,end] pairs. */
function windowsExcludedPortRanges(): Array<[number, number]> {
	try {
		const out = spawnSync("netsh", [
			"int",
			"ipv4",
			"show",
			"excludedportrange",
			"protocol=tcp",
		]).stdout?.toString();
		if (!out) return [];
		const ranges: Array<[number, number]> = [];
		for (const line of out.split(/\r?\n/)) {
			// Data rows look like "      8783        8882".
			const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
			if (m) ranges.push([Number(m[1]), Number(m[2])]);
		}
		return ranges;
	} catch {
		return [];
	}
}

/** TCP ports currently held by a LISTENING socket, from `netstat -ano`. */
function windowsInUsePorts(): Set<number> {
	const inUse = new Set<number>();
	try {
		const out = spawnSync("netstat", ["-ano"]).stdout?.toString();
		if (!out) return inUse;
		for (const line of out.split(/\r?\n/)) {
			if (!line.includes("LISTENING")) continue;
			// Foreign/Local address column: "  TCP    127.0.0.1:8787   ...  LISTENING"
			const m = line.match(/[:\s](\d+)\s+\S+\s+LISTENING/);
			if (m) inUse.add(Number(m[1]));
		}
	} catch {
		/* ignore */
	}
	return inUse;
}

/** First port >= desired that is not Windows-excluded and not in use (win32). */
function resolveWindowsPort(desired: number): number {
	if (process.platform !== "win32") return desired;
	const excluded = windowsExcludedPortRanges();
	const inUse = windowsInUsePorts();
	for (let port = desired; port < desired + 1000; port++) {
		if (inUse.has(port)) continue;
		if (excluded.some(([start, end]) => port >= start && port <= end)) continue;
		return port;
	}
	return desired; // give up; let wrangler surface the bind error
}

const port =
	process.platform === "win32" ? resolveWindowsPort(desiredPort) : desiredPort;

if (port !== desiredPort) {
	console.warn(
		`[electric-proxy:dev] port ${desiredPort} is unavailable on this Windows ` +
			`machine (Hyper-V/WSL reserve TCP port ranges; this is also what makes ` +
			`workerd crash with "std::terminate"). Using ${port} instead — point your ` +
			`Electric client / Caddy at http://127.0.0.1:${port}.`,
	);
}

const child = spawn(
	"wrangler",
	["dev", "--port", String(port), "--ip", "127.0.0.1"],
	{ stdio: "inherit", shell: true },
);
child.on("error", (error) => {
	console.error("[electric-proxy:dev] failed to spawn wrangler:", error);
	process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 0));

// Turbo tears persistent tasks down with SIGINT/SIGTERM — forward to wrangler.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => child.kill(signal));
}
