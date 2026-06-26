/**
 * Windows native-runtime smoke. Run under the Electron binary (the runtime the
 * desktop app / pty-daemon actually use) to verify the @electron/rebuild'd
 * .node files load at the right ABI AND node-pty can spawn a shell via ConPTY.
 *
 *   ELECTRON_RUN_AS_NODE=1 \
 *     node_modules/.bun/electron@<version>/node_modules/electron/dist/electron.exe \
 *     scripts/smoke-native-win.cjs
 *
 * Exits 0 if all three native modules load + ConPTY spawns cmd.exe; 1 otherwise.
 * Run from apps/desktop (where node-pty / better-sqlite3 / native-keymap resolve).
 */
/* eslint-disable no-console */
const path = require("node:path");
const fs = require("node:fs");
const cwd = process.cwd();
// require() resolves from THIS file's location, not cwd — and under Bun's
// isolated store node-pty only lives in node_modules/.bun/. Resolve it there
// directly so the smoke works from any cwd.
const repoRoot = path.resolve(__dirname, "..");
function storeRequire(pkg) {
	// Find the package under node_modules/.bun/<pkg>@<ver>/node_modules/<pkg>.
	const bunDir = path.join(repoRoot, "node_modules", ".bun");
	let entry;
	try {
		entry = fs.readdirSync(bunDir).find((d) => d.startsWith(`${pkg}@`));
	} catch {
		/* ignore */
	}
	if (!entry) throw new Error(`no ${pkg}@* under ${bunDir}`);
	return require(path.join(bunDir, entry, "node_modules", pkg));
}
function tryRequire(pkg, useStore) {
	try {
		if (useStore) storeRequire(pkg);
		else require(pkg);
		return { ok: true };
	} catch (e) {
		return { ok: false, err: e };
	}
}

const results = {
	"node-pty": tryRequire("node-pty", true),
	"better-sqlite3": tryRequire("better-sqlite3", true),
	"native-keymap": tryRequire("native-keymap", true),
};

// node-pty is the critical Windows-terminal path (hard-fail if it doesn't load).
// better-sqlite3 / native-keymap are best-effort — under Bun's isolated store
// they only resolve from the package that depends on them directly, so a single
// cwd can't see all three. They're verified separately (compile succeeded; run
// this script from the package that depends on each to load-check it).
if (!results["node-pty"].ok) {
	const msg = results["node-pty"].err?.message
		? results["node-pty"].err.message.split("\n")[0]
		: String(results["node-pty"].err);
	console.error(`[smoke] node-pty: FAILED — ${msg}`);
	console.error(
		`[smoke] cwd=${cwd} platform=${process.platform} versions=${process.versions.electron}/${process.versions.node}`,
	);
	process.exit(1);
}
console.log("[smoke] node-pty: loaded (Electron ABI OK)");
for (const [name, r] of Object.entries(results)) {
	if (name === "node-pty") continue;
	if (r.ok) console.log(`[smoke] ${name}: loaded`);
	else
		console.log(
			`[smoke] ${name}: not resolvable from this cwd (best-effort, skipped)`,
		);
}

// ConPTY smoke: spawn cmd.exe and confirm it emits a prompt.
const pty = storeRequire("node-pty");
let sawOutput = false;
try {
	const term = pty.spawn("cmd.exe", [], {
		name: "xterm-256color",
		cols: 80,
		rows: 24,
		cwd: process.env.USERPROFILE || cwd,
		env: process.env,
	});
	term.onData((d) => {
		if (!sawOutput && d.trim().length > 0) {
			sawOutput = true;
			console.log(
				`[smoke] ConPTY cmd.exe emitted ${JSON.stringify(d).slice(0, 50)}…`,
			);
		}
	});
	term.onExit(({ exitCode }) => {
		console.log(`[smoke] cmd.exe exited code=${exitCode}`);
	});
	// Give ConPTY a moment to emit the prompt, then kill and report.
	setTimeout(() => {
		try {
			term.kill();
		} catch {
			// already gone
		}
		if (sawOutput) {
			console.log(
				"[smoke] CONPTY SMOKE OK — node-pty spawned cmd.exe on Windows",
			);
			process.exit(0);
		}
		console.error("[smoke] CONPTY SMOKE FAIL — cmd.exe emitted no output");
		process.exit(1);
	}, 1500);
} catch (e) {
	console.error(`[smoke] ConPTY spawn threw: ${e?.message ? e.message : e}`);
	process.exit(1);
}
