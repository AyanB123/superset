import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config";
import { createCommandsPlugin, generateCommandsModuleSource } from "./plugin";

export async function runBuild(argv: string[]): Promise<void> {
	const { config, configPath, root } = await loadConfig(process.cwd());
	const commandsDir = resolve(root, config.commandsDir);

	let target: Bun.Build.CompileTarget | undefined;
	let outfile = resolve(root, config.outfile ?? `./dist/${config.name}`);
	for (const arg of argv) {
		if (arg.startsWith("--target=")) {
			target = arg.slice("--target=".length) as Bun.Build.CompileTarget;
		} else if (arg.startsWith("--outfile=")) {
			outfile = resolve(root, arg.slice("--outfile=".length));
		}
	}

	const cacheDir = resolve(root, "node_modules/.cache/cli-framework");
	mkdirSync(cacheDir, { recursive: true });

	// On Windows, `Bun.build({ compile, plugins })` reports success but writes no
	// output file (the commands plugin is the trigger — a known bun-on-Windows
	// JS-API gap). Work around it by pre-generating the commands barrel to a REAL
	// file and building plugin-free. macOS/Linux keep the virtual-module plugin
	// (proven there and not reproducible from Windows).
	const useGeneratedBarrel = process.platform === "win32";
	const commandsBarrelPath = useGeneratedBarrel
		? resolve(cacheDir, "commands-index.ts")
		: `${commandsDir}/index.ts`;
	if (useGeneratedBarrel) {
		writeFileSync(
			commandsBarrelPath,
			generateCommandsModuleSource(commandsDir),
		);
	}

	const entryPath = resolve(cacheDir, "entry.ts");
	writeFileSync(
		entryPath,
		`import config from ${JSON.stringify(configPath)};
import { commands, groups, middleware } from ${JSON.stringify(commandsBarrelPath)};
import { run } from "@superset/cli-framework";

await run({
	name: config.name,
	version: config.version,
	tree: { commands, groups, middleware },
	globals: config.globals,
});
`,
	);

	if (useGeneratedBarrel) {
		// Windows: Bun.build({ compile }) (JS-API) reports success but writes no
		// output file — a bun-on-Windows gap in compile mode. The CLI form
		// `bun build --compile` is unaffected, so spawn it. (process.execPath is
		// the real bun binary running this script, not an npm-global bun.cmd
		// shim — avoids the PATH-shadowing issue.)
		runCliCompile(entryPath, target, outfile, config.define);
	} else {
		// macOS/Linux: JS-API + virtual-module plugin (proven; the win32 CLI-form
		// path is untestable from there).
		const result = await Bun.build({
			entrypoints: [entryPath],
			plugins: [createCommandsPlugin({ commandsDir })],
			// The entry imports `bun` (e.g. `Glob`) and node builtins; bundle for
			// the Bun runtime explicitly. Without this Bun.build defaults its
			// bundle target to 'browser' and rejects those imports ("Browser build
			// cannot import Bun builtin") — observed when compiling for Windows.
			target: "bun",
			compile: target ? { target, outfile } : { outfile },
			define: config.define,
		});
		if (!result.success) {
			for (const log of result.logs) console.error(log);
			process.exit(1);
		}
	}

	// Verify the artifact exists regardless of path — fail loudly so we never
	// ship a build missing its CLI binary.
	if (!existsSync(outfile)) {
		console.error(`[cli-framework] build did not write ${outfile}.`);
		process.exit(1);
	}
	console.log(`[cli-framework] wrote ${outfile}`);
}

/** Compile the entry to a standalone binary via the `bun build --compile` CLI. */
function runCliCompile(
	entryPath: string,
	target: Bun.Build.CompileTarget | undefined,
	outfile: string,
	define: Record<string, string> | undefined,
): void {
	const args = ["build", entryPath, "--compile"];
	if (target) {
		args.push(`--target=${target}`);
	}
	args.push(`--outfile=${outfile}`);
	for (const [key, value] of Object.entries(define ?? {})) {
		args.push("--define", `${key}=${value}`);
	}
	const result = spawnSync(process.execPath, args, { stdio: "inherit" });
	if (result.error || result.status !== 0) {
		console.error(
			`[cli-framework] \`bun build --compile\` exited with ` +
				`${result.status ?? result.error?.message}`,
		);
		process.exit(result.status ?? 1);
	}
}
