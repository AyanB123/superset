/**
 * Cross-platform lint entry. Mirrors scripts/lint.sh:
 *   1. `biome check` over the args (fails on ANY diagnostic: error/warn/info).
 *   2. Structural ripgrep checks (desktop-git-env, git-ref-strings,
 *      simple-git usage).
 *
 * Run via `bun run lint` (→ `bun run scripts/lint.ts`). Invokes the local
 * `biome` bin directly — NOT `bunx @biomejs/biome@<ver>`, which fails to
 * resolve on Windows ("File not found"). The local install is the version
 * pinned in devDependencies.
 */
import { spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";

function runBiome(args: string[]): { output: string; status: number | null } {
	// Capture output so we can grep biome's diagnostic summary (the .sh wrapper
	// fails on "Found N error|info|warning", not just on biome's exit code).
	// stdio:"inherit" would print to the terminal but leave stdout null.
	const result = spawnSync("biome", args, {
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		shell: isWindows,
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	if (output.trim()) process.stdout.write(output);
	return { output, status: result.status };
}

const biomeArgs = process.argv.slice(2);
const biome = runBiome([
	"check",
	// Default to the repo root so a bare `bun run lint` checks everything.
	...(biomeArgs.length > 0 ? biomeArgs : ["."]),
]);
// Fail on ANY diagnostic (error/warn/info) — biome's exit code alone isn't the
// gate; the original .sh wrapper greps the output for the summary line.
const hasDiagnostics = /Found \d+ (error|info|warning)/.test(biome.output);
const biomeFailed = biome.status !== 0;

const structuralChecks = [
	"scripts/check-desktop-git-env.ts",
	"scripts/check-git-ref-strings.ts",
	"scripts/check-simple-git-usage.ts",
];
let structuralFailed = false;
if (hasRipgrep()) {
	for (const script of structuralChecks) {
		const result = spawnSync("bun", ["run", script], {
			stdio: "inherit",
			shell: isWindows,
		});
		if (result.status !== 0) structuralFailed = true;
	}
} else {
	console.warn(
		"[lint] ripgrep not found — skipping structural checks (desktop-git-env, git-ref-strings, simple-git). " +
			"Install ripgrep to enforce them locally.",
	);
}

process.exit(hasDiagnostics || biomeFailed || structuralFailed ? 1 : 0);

function hasRipgrep(): boolean {
	const result = spawnSync(isWindows ? "rg.exe" : "rg", ["--version"], {
		stdio: "ignore",
		shell: isWindows,
	});
	return result.status === 0;
}
