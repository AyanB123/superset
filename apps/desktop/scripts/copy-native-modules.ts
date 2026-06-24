/**
 * Prepare native modules for electron-builder.
 *
 * With Bun 1.3+ isolated installs, node_modules contains symlinks to packages
 * stored in node_modules/.bun/. electron-builder cannot follow these symlinks
 * when creating asar archives.
 *
 * This script:
 * 1. Detects if native modules are symlinks
 * 2. Replaces symlinks with actual file copies
 * 3. electron-builder can then properly package and unpack them
 *
 * This is safe because bun install will recreate the symlinks on next install.
 */

import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { satisfies } from "semver";
import { requiredMaterializedNodeModules } from "../runtime-dependencies";

// Target architecture for cross-compilation. When set, platform-specific
// packages for this arch are fetched from npm if not already present.
// Set via TARGET_ARCH env var (e.g., TARGET_ARCH=x64).
const TARGET_ARCH = process.env.TARGET_ARCH || process.arch;
const TARGET_PLATFORM = process.env.TARGET_PLATFORM || process.platform;

function getWorkspaceRootNodeModulesDir(nodeModulesDir: string): string {
	return join(nodeModulesDir, "..", "..", "..", "node_modules");
}

function getBunFlatNodeModulesDir(nodeModulesDir: string): string {
	return join(
		getWorkspaceRootNodeModulesDir(nodeModulesDir),
		".bun",
		"node_modules",
	);
}

function getBunStoreDir(nodeModulesDir: string): string {
	return join(getWorkspaceRootNodeModulesDir(nodeModulesDir), ".bun");
}

function findBunStoreFolderName(
	bunStoreDir: string,
	moduleName: string,
	version: string,
): string | null {
	if (!existsSync(bunStoreDir)) return null;
	const entries = readdirSync(bunStoreDir);
	const modulePrefix = `${moduleName.replace("/", "+")}@`;
	const exactPrefix = `${modulePrefix}${version}`;
	const exactMatch = entries.find((entry) => entry.startsWith(exactPrefix));
	if (exactMatch) return exactMatch;
	return entries.find((entry) => entry.startsWith(modulePrefix)) ?? null;
}

function copyModuleIfSymlink(
	nodeModulesDir: string,
	moduleName: string,
	required: boolean,
): boolean {
	const modulePath = join(nodeModulesDir, moduleName);
	const bunFlatNodeModulesDir = getBunFlatNodeModulesDir(nodeModulesDir);
	const bunFlatModulePath = join(bunFlatNodeModulesDir, moduleName);

	if (!existsSync(modulePath)) {
		if (existsSync(bunFlatModulePath)) {
			console.log(`  ${moduleName}: materializing from Bun store index`);
			mkdirSync(dirname(modulePath), { recursive: true });
			cpSync(realpathSync(bunFlatModulePath), modulePath, { recursive: true });
			console.log(`    Copied to: ${modulePath}`);
			return true;
		}
		if (required) {
			console.error(`  [ERROR] ${moduleName} not found at ${modulePath}`);
			process.exit(1);
		}
		console.log(`  ${moduleName}: not found (skipping)`);
		return false;
	}

	const stats = lstatSync(modulePath);

	if (stats.isSymbolicLink()) {
		// Resolve symlink to get real path
		const realPath = realpathSync(modulePath);
		console.log(`  ${moduleName}: symlink -> replacing with real files`);
		console.log(`    Real path: ${realPath}`);

		// Remove the symlink
		rmSync(modulePath);

		// Copy the actual files
		cpSync(realPath, modulePath, { recursive: true });

		console.log(`    Copied to: ${modulePath}`);
	} else {
		console.log(`  ${moduleName}: already real directory (not a symlink)`);
	}

	return true;
}

function readInstalledModuleVersion(modulePath: string): string | null {
	const packageJsonPath = join(modulePath, "package.json");
	if (!existsSync(packageJsonPath)) return null;
	type PackageJson = { version?: string };
	const packageJson = JSON.parse(
		readFileSync(packageJsonPath, "utf8"),
	) as PackageJson;
	return packageJson.version ?? null;
}

async function copyExactModuleVersion(
	nodeModulesDir: string,
	moduleName: string,
	version: string,
	destPath: string,
	required: boolean,
): Promise<boolean> {
	const bunStoreDir = getBunStoreDir(nodeModulesDir);
	const bunStoreFolderName = findBunStoreFolderName(
		bunStoreDir,
		moduleName,
		version,
	);
	if (bunStoreFolderName) {
		const sourcePath = join(
			bunStoreDir,
			bunStoreFolderName,
			"node_modules",
			moduleName,
		);
		if (existsSync(sourcePath)) {
			mkdirSync(dirname(destPath), { recursive: true });
			cpSync(sourcePath, destPath, { recursive: true });
			console.log(`    Copied ${moduleName}@${version} to: ${destPath}`);
			return true;
		}
	}

	if (await fetchNpmPackage(moduleName, version, destPath)) {
		return true;
	}

	if (required) {
		console.error(
			`  [ERROR] Failed to materialize ${moduleName}@${version} at ${destPath}`,
		);
		process.exit(1);
	}

	return false;
}

async function copyDependencyForPackage(
	nodeModulesDir: string,
	parentModuleName: string,
	dependencyName: string,
	dependencyRange: string,
	required: boolean,
): Promise<void> {
	const topLevelDependencyPath = join(nodeModulesDir, dependencyName);
	const topLevelVersion = readInstalledModuleVersion(topLevelDependencyPath);

	if (topLevelVersion && satisfies(topLevelVersion, dependencyRange)) {
		copyModuleIfSymlink(nodeModulesDir, dependencyName, required);
		return;
	}

	if (!topLevelVersion) {
		console.log(
			`  ${dependencyName}: top-level version missing; materializing ${dependencyRange} at the workspace root`,
		);
		await copyExactModuleVersion(
			nodeModulesDir,
			dependencyName,
			dependencyRange,
			topLevelDependencyPath,
			required,
		);
		return;
	}

	const nestedDependencyPath = join(
		nodeModulesDir,
		parentModuleName,
		"node_modules",
		dependencyName,
	);
	const nestedVersion = readInstalledModuleVersion(nestedDependencyPath);
	if (nestedVersion && satisfies(nestedVersion, dependencyRange)) {
		const nestedStats = lstatSync(nestedDependencyPath);
		if (nestedStats.isSymbolicLink()) {
			const realPath = realpathSync(nestedDependencyPath);
			rmSync(nestedDependencyPath);
			cpSync(realPath, nestedDependencyPath, {
				recursive: true,
			});
		}
		return;
	}

	console.log(
		`  ${dependencyName}: top-level version ${topLevelVersion ?? "missing"} does not satisfy ${dependencyRange}; materializing nested copy for ${parentModuleName}`,
	);

	await copyExactModuleVersion(
		nodeModulesDir,
		dependencyName,
		dependencyRange,
		nestedDependencyPath,
		required,
	);
}

/**
 * Extract a gzipped USTAR tarball buffer into destPath, stripping 1 leading
 * path component (mirrors `tar xz --strip-components=1`). Self-contained so
 * the build doesn't depend on a system shell, curl, or tar binary — it runs
 * identically on macOS, Linux, and Windows.
 */
function extractTgzStripOne(buffer: Buffer, destPath: string): void {
	const tar = gunzipSync(buffer);
	const BLOCK = 512;

	// USTAR header field offsets (bytes).
	const NAME = 0;
	const SIZE = 124;
	const TYPEFLAG = 156;
	const PREFIX = 345;

	let offset = 0;
	while (offset + BLOCK <= tar.length) {
		const header = tar.subarray(offset, offset + BLOCK);
		// Two consecutive zero blocks mark the end of the archive.
		if (header.every((byte) => byte === 0)) break;

		// Name: NUL-terminated at field start; size: octal, space/NUL terminated.
		const nameEnd = header.indexOf(0, NAME);
		const name = header
			.subarray(NAME, nameEnd === -1 ? 100 : nameEnd)
			.toString("utf8");
		const prefixEnd = header.indexOf(0, PREFIX);
		const prefix =
			prefixEnd === -1
				? header.subarray(PREFIX, PREFIX + 155).toString("utf8")
				: header.subarray(PREFIX, prefixEnd).toString("utf8");
		const rawSize = header
			.subarray(SIZE, SIZE + 12)
			.toString("utf8")
			.trim();
		const size = Number.parseInt(rawSize || "0", 8) || 0;
		const typeflag = String.fromCharCode(header[TYPEFLAG] ?? 0);

		offset += BLOCK;
		const fileStart = offset;
		offset += size + ((BLOCK - (size % BLOCK)) % BLOCK); // data is block-aligned

		if (!name) continue;

		// Strip the leading "package/" path component that npm tarballs use.
		const entryPath = stripOneComponent(prefix ? `${prefix}/${name}` : name);
		if (!entryPath) continue;

		const fullPath = join(destPath, entryPath);

		// '5' = directory entry; create it and move on.
		if (typeflag === "5") {
			mkdirSync(fullPath, { recursive: true });
			continue;
		}
		// Normal file ('\0'/'0') and contiguous file ('7') — write the payload.
		if (
			typeflag === "0" ||
			typeflag === "\0" ||
			typeflag === "" ||
			typeflag === "7"
		) {
			mkdirSync(dirname(fullPath), { recursive: true });
			writeFileSync(fullPath, tar.subarray(fileStart, fileStart + size));
			continue;
		}
		// Symlinks ('2'), hardlinks ('1'), PAX/GNU long-name headers ('L','K','x','g'),
		// and anything else are intentionally not materialized: the native packages
		// this fetches (ast-grep / libsql / duckdb / parcel-watcher bindings) ship
		// self-contained .node/.dll payloads with no symlinks. A future dependency
		// bump that DOES carry a load-bearing symlink would surface here — warn so
		// the silent-drop failure mode stays diagnosable instead of becoming a
		// cryptic "cannot find module" at runtime.
		console.warn(
			`[copy-native-modules] USTAR entry not extracted (typeflag=${JSON.stringify(typeflag)}): ${entryPath}`,
		);
	}
}

/**
 * Drop the first segment of a posix/ustar path. Returns "" for single-segment
 * paths (which have nothing left after stripping and are skipped).
 */
function stripOneComponent(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	const slash = normalized.indexOf("/");
	return slash === -1 ? "" : normalized.slice(slash + 1);
}

/**
 * Fetch an npm package tarball and extract it to destPath.
 * Used when cross-compiling and the target platform package isn't in the Bun store.
 *
 * No shell invocation: uses global fetch() + node:zlib gunzip + a self-contained
 * USTAR reader, so it works identically on macOS, Linux, and Windows.
 */
async function fetchNpmPackage(
	packageName: string,
	version: string,
	destPath: string,
): Promise<boolean> {
	// npm tarball URL: @scope/pkg/-/pkg-version.tgz (filename uses pkg name without scope)
	const barePackageName = packageName.includes("/")
		? packageName.split("/")[1]
		: packageName;
	const url = `https://registry.npmjs.org/${packageName}/-/${barePackageName}-${version}.tgz`;
	console.log(`  ${packageName}: fetching from npm (${version})`);
	try {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}
		const buffer = Buffer.from(await response.arrayBuffer());
		mkdirSync(destPath, { recursive: true });
		extractTgzStripOne(buffer, destPath);
		console.log(`    Extracted to: ${destPath}`);
		return true;
	} catch (err) {
		console.error(
			`  [ERROR] Failed to fetch ${packageName}@${version}: ${err}`,
		);
		return false;
	}
}

async function copyAstGrepPlatformPackages(
	nodeModulesDir: string,
): Promise<void> {
	const astGrepNapiPath = join(nodeModulesDir, "@ast-grep", "napi");
	if (!existsSync(astGrepNapiPath)) return;

	const astGrepPkgJsonPath = join(astGrepNapiPath, "package.json");
	if (!existsSync(astGrepPkgJsonPath)) return;

	type AstGrepPackageJson = {
		optionalDependencies?: Record<string, string>;
	};
	const astGrepPkg = JSON.parse(
		readFileSync(astGrepPkgJsonPath, "utf8"),
	) as AstGrepPackageJson;
	const optionalDeps = astGrepPkg.optionalDependencies ?? {};
	const platformPackages = Object.entries(optionalDeps)
		.filter(([name]) => name.startsWith("@ast-grep/napi-"))
		.map(([name, version]) => ({ name, version }));

	if (platformPackages.length === 0) return;

	// Determine which platform package we need for the target arch
	const targetPlatformSuffix = `${TARGET_PLATFORM === "darwin" ? "darwin" : TARGET_PLATFORM === "win32" ? "win32" : "linux"}-${TARGET_ARCH}`;
	const targetPkg = platformPackages.find((pkg) =>
		pkg.name.includes(targetPlatformSuffix),
	);

	// Bun isolated installs keep package payloads in workspaceRoot/node_modules/.bun
	const bunStoreDir = getBunStoreDir(nodeModulesDir);
	let resolvedTargetPackage = false;

	for (const platformPkg of platformPackages) {
		const isTargetPkg = targetPkg && platformPkg.name === targetPkg.name;
		const destPath = join(nodeModulesDir, platformPkg.name);
		if (existsSync(destPath)) {
			const copied = copyModuleIfSymlink(
				nodeModulesDir,
				platformPkg.name,
				false,
			);
			if (isTargetPkg && copied) resolvedTargetPackage = true;
			continue;
		}

		const bunStoreFolderName = findBunStoreFolderName(
			bunStoreDir,
			platformPkg.name,
			platformPkg.version,
		);
		if (bunStoreFolderName) {
			const sourcePath = join(
				bunStoreDir,
				bunStoreFolderName,
				"node_modules",
				platformPkg.name,
			);
			if (existsSync(sourcePath)) {
				console.log(`  ${platformPkg.name}: copying from Bun store`);
				mkdirSync(dirname(destPath), { recursive: true });
				cpSync(sourcePath, destPath, { recursive: true });
				if (isTargetPkg) resolvedTargetPackage = true;
				continue;
			}
		}

		// If this is the target platform package and it's not in the Bun store,
		// fetch it from npm (cross-compilation scenario)
		if (isTargetPkg) {
			if (
				await fetchNpmPackage(platformPkg.name, platformPkg.version, destPath)
			) {
				resolvedTargetPackage = true;
				continue;
			}
		}

		console.warn(
			`  ${platformPkg.name}: not found in Bun store or node_modules`,
		);
	}

	if (!resolvedTargetPackage) {
		console.error(
			`  [ERROR] Target platform package ${targetPkg?.name ?? `@ast-grep/napi-${targetPlatformSuffix}`} was not materialized`,
		);
		process.exit(1);
	}
}

async function copyLibsqlDependencies(nodeModulesDir: string): Promise<void> {
	const libsqlPath = join(nodeModulesDir, "libsql");
	const libsqlPkgJsonPath = join(libsqlPath, "package.json");
	if (!existsSync(libsqlPkgJsonPath)) return;

	type LibsqlPackageJson = {
		dependencies?: Record<string, string>;
		optionalDependencies?: Record<string, string>;
	};
	const libsqlPkg = JSON.parse(
		readFileSync(libsqlPkgJsonPath, "utf8"),
	) as LibsqlPackageJson;
	const deps = libsqlPkg.dependencies ?? {};
	const optionalDeps = libsqlPkg.optionalDependencies ?? {};

	console.log("\nPreparing libsql runtime dependencies...");
	for (const [dep, version] of Object.entries(deps)) {
		await copyDependencyForPackage(
			nodeModulesDir,
			"libsql",
			dep,
			version,
			true,
		);
	}

	// Copy whichever optional native platform packages Bun installed for this platform.
	for (const dep of Object.keys(optionalDeps)) {
		copyModuleIfSymlink(nodeModulesDir, dep, false);
	}

	// Some Bun installs place optional deps under .bun/node_modules/@scope.
	// Mirror discovered @libsql optional packages if present there.
	const bunFlatLibsqlScopePath = join(
		getBunFlatNodeModulesDir(nodeModulesDir),
		"@libsql",
	);
	if (existsSync(bunFlatLibsqlScopePath)) {
		for (const entry of readdirSync(bunFlatLibsqlScopePath)) {
			if (
				!entry.includes("darwin") &&
				!entry.includes("linux") &&
				!entry.includes("win32")
			) {
				continue;
			}
			copyModuleIfSymlink(nodeModulesDir, `@libsql/${entry}`, false);
		}
	}

	// Cross-compilation: ensure the target platform's @libsql package is present
	const targetSuffix = `${TARGET_PLATFORM}-${TARGET_ARCH}`;
	const targetLibsqlPkgs = Object.entries(optionalDeps).filter(([name]) =>
		name.includes(targetSuffix),
	);
	for (const [name, version] of targetLibsqlPkgs) {
		const destPath = join(nodeModulesDir, name);
		if (!existsSync(destPath)) {
			await fetchNpmPackage(name, version, destPath);
		}
	}
}

function copyParcelWatcherPlatformPackages(nodeModulesDir: string): void {
	const watcherPath = join(nodeModulesDir, "@parcel", "watcher");
	const watcherPkgJsonPath = join(watcherPath, "package.json");
	if (!existsSync(watcherPkgJsonPath)) return;

	type ParcelWatcherPackageJson = {
		optionalDependencies?: Record<string, string>;
	};
	const watcherPkg = JSON.parse(
		readFileSync(watcherPkgJsonPath, "utf8"),
	) as ParcelWatcherPackageJson;
	const optionalDeps = watcherPkg.optionalDependencies ?? {};
	const platformPackages = Object.entries(optionalDeps)
		.filter(([name]) => name.startsWith("@parcel/watcher-"))
		.map(([name, version]) => ({ name, version }));

	if (platformPackages.length === 0) return;

	console.log("\nPreparing parcel watcher platform package...");
	const bunStoreDir = getBunStoreDir(nodeModulesDir);
	let resolvedPlatformPackage = false;

	for (const platformPkg of platformPackages) {
		const destPath = join(nodeModulesDir, platformPkg.name);
		if (existsSync(destPath)) {
			resolvedPlatformPackage =
				copyModuleIfSymlink(nodeModulesDir, platformPkg.name, false) ||
				resolvedPlatformPackage;
			continue;
		}

		const bunStoreFolderName = findBunStoreFolderName(
			bunStoreDir,
			platformPkg.name,
			platformPkg.version,
		);
		if (!bunStoreFolderName) {
			console.warn(
				`  ${platformPkg.name}: no Bun store entry matched version ${platformPkg.version}`,
			);
			continue;
		}

		const sourcePath = join(
			bunStoreDir,
			bunStoreFolderName,
			"node_modules",
			platformPkg.name,
		);
		if (!existsSync(sourcePath)) {
			console.warn(
				`  ${platformPkg.name}: Bun store path missing after resolve (${sourcePath})`,
			);
			continue;
		}

		console.log(`  ${platformPkg.name}: copying from Bun store`);
		mkdirSync(dirname(destPath), { recursive: true });
		cpSync(sourcePath, destPath, { recursive: true });
		resolvedPlatformPackage = true;
	}

	if (!resolvedPlatformPackage) {
		console.error(
			"  [ERROR] No `@parcel/watcher-<platform>` runtime package was materialized",
		);
		process.exit(1);
	}
}

async function copyDuckdbPlatformPackages(
	nodeModulesDir: string,
): Promise<void> {
	const nodeBindingsPath = join(nodeModulesDir, "@duckdb", "node-bindings");
	const nodeBindingsPkgJsonPath = join(nodeBindingsPath, "package.json");
	if (!existsSync(nodeBindingsPkgJsonPath)) return;

	type DuckdbBindingsPackageJson = {
		optionalDependencies?: Record<string, string>;
	};
	const nodeBindingsPkg = JSON.parse(
		readFileSync(nodeBindingsPkgJsonPath, "utf8"),
	) as DuckdbBindingsPackageJson;
	const optionalDeps = nodeBindingsPkg.optionalDependencies ?? {};

	console.log("\nPreparing duckdb platform package...");

	// The native binding is a `cpu`/`os`-gated optional dependency, so Bun only
	// installs the host's. For the target arch, fetch it from npm when missing.
	const targetSuffix = `${TARGET_PLATFORM}-${TARGET_ARCH}`;
	const targetEntry = Object.entries(optionalDeps).find(([name]) =>
		name.endsWith(targetSuffix),
	);
	if (!targetEntry) {
		console.error(
			`  [ERROR] No @duckdb/node-bindings optional dependency matched ${targetSuffix}`,
		);
		process.exit(1);
	}

	const [targetName, targetVersion] = targetEntry;
	const destPath = join(nodeModulesDir, targetName);
	if (existsSync(destPath)) {
		copyModuleIfSymlink(nodeModulesDir, targetName, true);
		return;
	}

	await copyExactModuleVersion(
		nodeModulesDir,
		targetName,
		targetVersion,
		destPath,
		true,
	);
}

async function prepareNativeModules() {
	console.log("Preparing external runtime modules for electron-builder...");
	console.log(
		`  Target: ${TARGET_PLATFORM}/${TARGET_ARCH} (host: ${process.platform}/${process.arch})`,
	);

	// bun creates symlinks for direct dependencies in the workspace's node_modules
	const nodeModulesDir = join(dirname(import.meta.dirname), "node_modules");

	console.log("\nMaterializing packaged runtime modules...");
	for (const moduleName of requiredMaterializedNodeModules) {
		copyModuleIfSymlink(nodeModulesDir, moduleName, true);
	}

	console.log("\nPreparing ast-grep platform package...");
	await copyAstGrepPlatformPackages(nodeModulesDir);
	copyParcelWatcherPlatformPackages(nodeModulesDir);
	await copyLibsqlDependencies(nodeModulesDir);
	await copyDuckdbPlatformPackages(nodeModulesDir);

	console.log("\nDone!");
}

await prepareNativeModules();
