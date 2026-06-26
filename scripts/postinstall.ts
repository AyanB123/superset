/**
 * Cross-platform postinstall. Runs under `bun` on every OS — no shell.
 *
 * Mirrors the old scripts/postinstall.sh exactly:
 *  1. Guard against recursion (electron-builder install-app-deps triggers
 *     nested bun installs that would re-run this).
 *  2. Run sherif for workspace validation.
 *  3. Skip the desktop native rebuild on CI (parallel install jobs don't
 *     need it and it has been flaky with native deps mid-materialization).
 *  4. Rebuild native deps for the desktop app (electron-builder
 *     install-app-deps) — requires VS Build Tools + Python on Windows for
 *     node-pty, which has no prebuilt binary.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { patchNativeBuildsForWindows } from "./patch-native-builds.ts";

const RECURSION_ENV = "SUPERSET_POSTINSTALL_RUNNING";

if (process.env[RECURSION_ENV]) {
	process.exit(0);
}
process.env[RECURSION_ENV] = "1";

function run(command: string, args: string[]): void {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.error) {
		// ENOENT under shell:false means the binary isn't on PATH. Surface it
		// clearly rather than letting bun print an opaque spawn failure.
		const target = `${command} ${args.join(" ")}`;
		console.error(
			`postinstall: failed to run \`${target}\`: ${result.error.message}`,
		);
		process.exit(result.error.errno === "ENOENT" ? 127 : 1);
	}
	if (result.status !== 0) {
		console.error(
			`postinstall: \`${command}\` exited with status ${result.status}`,
		);
		process.exit(result.status ?? 1);
	}
}

// Native packages the desktop loads at runtime under Electron's ABI. Bun's
// installer occasionally leaves one of these with an incomplete store entry
// (the store dir + its transitive sub-deps exist, but the package's own files —
// package.json, src/, binding.gyp — are absent) after a flaky registry fetch.
// electron-rebuild then can't compile it and the desktop fails to require() it
// at startup. Self-heal by re-extracting the package from its npm tarball, so a
// fresh `bun install` recovers instead of needing a manual curl+tar. Runs on
// every OS (the flaky-fetch symptom isn't Windows-specific); idempotent no-op
// when the entry is already complete.
const CRITICAL_NATIVE_PACKAGES = [
	"better-sqlite3",
	"node-pty",
	"native-keymap",
];

function healIncompleteNativePackages(repoRoot: string): void {
	const bunStore = resolve(repoRoot, "node_modules", ".bun");
	if (!existsSync(bunStore)) return;
	let entries: string[];
	try {
		entries = readdirSync(bunStore);
	} catch {
		return;
	}
	for (const pkg of CRITICAL_NATIVE_PACKAGES) {
		const entry = entries.find((d) => d.startsWith(`${pkg}@`));
		if (!entry) continue; // not materialized at all — install:deps will surface it
		const pkgDir = resolve(bunStore, entry, "node_modules", pkg);
		if (existsSync(resolve(pkgDir, "package.json"))) continue; // complete
		const version = entry.slice(pkg.length + 1); // "<ver>" after "pkg@"
		console.warn(
			`postinstall: ${pkg}@${version} store entry is incomplete (likely a flaky ` +
				`fetch). Re-extracting from the npm tarball…`,
		);
		extractNpmTarball(pkg, version, pkgDir);
	}
}

function extractNpmTarball(
	pkg: string,
	version: string,
	destDir: string,
): void {
	// Tarball filename strips the scope: "@scope/name@x" -> "name-x.tgz".
	const name = pkg.includes("/") ? pkg.split("/")[1] : pkg;
	const url = `https://registry.npmjs.org/${pkg}/-/${name}-${version}.tgz`;
	mkdirSync(destDir, { recursive: true });
	// Download into destDir under a RELATIVE name, then extract with cwd=destDir +
	// the relative name. Passing a Windows drive-letter path (C:\...) as a tar arg
	// makes GNU tar read "C:..." as a remote host:path (--force-local isn't
	// portable to bsdtar), and piping a large payload via spawnSync `input` is
	// unreliable under bun. A relative name + cwd works for GNU tar AND bsdtar.
	const tarballName = `${name}-${version}.tgz`;
	const tarballPath = resolve(destDir, tarballName);
	const dl = spawnSync("curl", [
		"-fsSL",
		"--retry",
		"3",
		"-o",
		tarballPath,
		url,
	]);
	if (dl.error || dl.status !== 0 || !existsSync(tarballPath)) {
		console.error(
			`postinstall: could not fetch ${url} (curl status ${dl.status}). ` +
				`Re-run \`bun install\`, or download + extract the tarball into ${destDir} manually.`,
		);
		return;
	}
	// npm tarballs extract to a top-level "package/" dir — strip that one component.
	const ext = spawnSync("tar", ["-xzf", tarballName, "--strip-components=1"], {
		cwd: destDir,
	});
	try {
		unlinkSync(tarballPath);
	} catch {
		/* best-effort cleanup of the temp tarball */
	}
	if (ext.error || ext.status !== 0) {
		console.error(
			`postinstall: could not extract ${pkg}@${version} (tar status ${ext.status}). ` +
				`Re-run \`bun install\` or extract the tarball into ${destDir} manually.`,
		);
		return;
	}
	console.log(`postinstall: healed ${pkg}@${version} from npm tarball.`);
}

// Run sherif for workspace validation. `sherif` is a standalone Rust binary
// with published Windows builds; `shell:true` on win32 lets it resolve via
// PATHEXT (and bun's bin shim) the same way the unix PATH lookup does.
run("sherif", []);

// GitHub CI runs multiple Bun install jobs that do not need desktop native
// rebuilds. Running electron-builder here can trigger nested Bun installs
// while the main install is still materializing packages, which has been
// flaky with native deps.
if (process.env.CI) {
	process.exit(0);
}

// Self-heal any critical native package whose store entry a flaky fetch left
// incomplete. Run BEFORE patching so a freshly-extracted binding.gyp is patched
// too, and before install:deps so electron-rebuild finds a complete package.
healIncompleteNativePackages(process.cwd());

// On Windows, patch native-module gyp files so they compile for Electron under
// (a) a repo path containing a space (node-gyp #65) and (b) VS Build Tools
// without the Spectre-mitigated libs component. Applies to node-pty (the only
// native dep with no Electron-ABI prebuilt — @electron/rebuild compiles it) and
// any other compiling addon (native-keymap, …). Idempotent + win32-only.
// See scripts/patch-native-builds.ts.
patchNativeBuildsForWindows(process.cwd());

// Install native dependencies for desktop app.
run("bun", ["run", "--filter=@superset/desktop", "install:deps"]);
