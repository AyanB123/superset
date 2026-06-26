import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Minimal KEY=VALUE env loader (a tiny subset of dotenv). Used to read `.dev.vars`
 * (the worker's bindings, which wrangler auto-loads) and the root `.env` without
 * pulling in the dotenv package as a dependency of this app.
 *
 * Does not override values already present in process.env (mirrors dotenv's
 * default non-override behaviour).
 */
export function loadEnvFile(file: URL | string): void {
	const path = file instanceof URL ? fileURLToPath(file) : file;
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return; // missing file is fine — nothing to load
	}
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key && !(key in process.env)) {
			process.env[key] = value;
		}
	}
}
