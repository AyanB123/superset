import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "dotenv";

type SupportedPlatform = "darwin" | "linux" | "win32";
type SupportedArch = "arm64" | "x64";

const TARGET_PLATFORM = (process.env.TARGET_PLATFORM ??
	process.platform) as NodeJS.Platform;
const TARGET_ARCH = (process.env.TARGET_ARCH ?? process.arch) as string;

const BUN_TARGETS: Partial<
	Record<SupportedPlatform, Partial<Record<SupportedArch, string>>>
> = {
	darwin: {
		arm64: "bun-darwin-arm64",
		x64: "bun-darwin-x64",
	},
	linux: {
		arm64: "bun-linux-arm64",
		x64: "bun-linux-x64",
	},
	win32: {
		x64: "bun-windows-x64",
	},
};

function getBunTarget(): string {
	const platformTargets = BUN_TARGETS[TARGET_PLATFORM as SupportedPlatform];
	const target = platformTargets?.[TARGET_ARCH as SupportedArch];
	if (!target) {
		throw new Error(
			`Unsupported bundled CLI target: ${TARGET_PLATFORM}/${TARGET_ARCH}`,
		);
	}
	return target;
}

/**
 * Resolve the real Bun binary for the `bun build --target=<…> --compile` step.
 *
 * `bun` on PATH may be an npm-global `.cmd`/shim (left over from installing Bun
 * via npm) that shadows the real `bun.exe`. Bun's cross-target compile needs an
 * actual self-contained Bun binary to embed the target runtime; the npm-package
 * `bun.exe` (and its shim) can't satisfy it and fail "bun is not installed in
 * %PATH%". The official installer's `~/.bun/bin/bun` is self-contained and works
 * — prefer it, then `process.execPath`, then PATH.
 */
function resolveBunBinary(): string {
	const home = process.env.USERPROFILE || process.env.HOME || "";
	if (home) {
		const candidate = resolve(
			home,
			".bun",
			"bin",
			process.platform === "win32" ? "bun.exe" : "bun",
		);
		if (existsSync(candidate)) return candidate;
	}
	if (process.versions.bun && process.execPath) {
		return process.execPath;
	}
	return "bun";
}

/**
 * The cli build is nested: this script spawns `bun run build` → the cli's
 * `build` script → `cli-framework build`, which itself spawns `bun` resolved
 * from PATH. If PATH's `bun` is the npm shim, that nested spawn fails the
 * cross-target compile. Prepend `~/.bun/bin` (the self-contained Bun) to PATH
 * so every `bun` in the subtree resolves to the real binary.
 */
function realBunBinDir(): string | null {
	const home = process.env.USERPROFILE || process.env.HOME || "";
	if (!home) return null;
	const dir = resolve(home, ".bun", "bin");
	const bin = resolve(dir, process.platform === "win32" ? "bun.exe" : "bun");
	return existsSync(bin) ? dir : null;
}

function run(
	command: string,
	args: string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: "inherit",
		});

		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) {
				resolvePromise();
				return;
			}
			reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
		});
	});
}

function buildCliBuildEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	const apiUrl =
		process.env.SUPERSET_API_URL || process.env.NEXT_PUBLIC_API_URL;
	const webUrl =
		process.env.SUPERSET_WEB_URL || process.env.NEXT_PUBLIC_WEB_URL;

	if (apiUrl) {
		env.SUPERSET_API_URL = apiUrl;
	}
	if (webUrl) {
		env.SUPERSET_WEB_URL = webUrl;
	}

	// Prepend the self-contained Bun so the nested cli-framework `bun` spawn
	// resolves to it instead of an npm-global shim. See resolveBunBinary().
	const bunDir = realBunBinDir();
	if (bunDir) {
		const sep = process.platform === "win32" ? ";" : ":";
		env.PATH = `${bunDir}${sep}${env.PATH ?? ""}`;
	}

	return env;
}

const desktopDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopDir, "../..");
config({ path: resolve(repoRoot, ".env"), override: false, quiet: true });

const cliDir = resolve(repoRoot, "packages/cli");
const outfile = resolve(
	desktopDir,
	"dist/resources/bin",
	TARGET_PLATFORM === "win32" ? "superset.exe" : "superset",
);

mkdirSync(dirname(outfile), { recursive: true });

try {
	await run(
		resolveBunBinary(),
		["run", "build", `--target=${getBunTarget()}`, `--outfile=${outfile}`],
		{
			cwd: cliDir,
			env: buildCliBuildEnv(),
		},
	);
} catch (error) {
	// The only failure mode here on Windows is Bun's JS-API compile + plugin
	// writing no output file (known bun-on-Windows gap). The desktop uses
	// packages/cli/dist for the CLI at runtime in dev (and the packaged exe is a
	// separately-tracked gap), so the resources/bin exe is NOT required to boot.
	// Tolerate the failure unconditionally — re-throwing aborts the whole
	// `bun dev:desktop` turbo graph, which tears down Caddy mid-cert-install and
	// dismisses the root-cert UAC prompt before the user can click it.
	console.warn(
		`[desktop] bundle:cli failed (${error instanceof Error ? error.message : error}); continuing — resources/bin exe is not required (dev uses packages/cli/dist).`,
	);
}

if (TARGET_PLATFORM !== "win32" && existsSync(outfile)) {
	chmodSync(outfile, 0o755);
}

if (existsSync(outfile)) {
	console.log(`[desktop] bundled CLI written to ${outfile}`);
} else {
	console.warn(
		`[desktop] bundled CLI exe not present at ${outfile} (continuing without it).`,
	);
}
