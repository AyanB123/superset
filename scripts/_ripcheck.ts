/**
 * Shared helper for the structural lint checks (ripgrep-based). Each check
 * is a list of {message, pattern, globs} entries; if ripgrep finds any
 * match, it's a violation. Exits 1 on any violation, 0 otherwise.
 *
 * Uses ripgrep with PCRE2 to match the original .sh checks exactly. On Windows
 * ripgrep is resolved via PATHEXT (shell:true).
 */
import { spawnSync } from "node:child_process";

export interface RipcheckRule {
	message: string;
	pattern: string;
	/** Paths / globs to scan. */
	targets?: string[];
	/** Glob filters (e.g. negated test-file patterns). */
	globs?: string[];
	/** Restrict to a type, e.g. ts. */
	type?: string;
}

export function runRipchecks(rules: RipcheckRule[]): void {
	const isWindows = process.platform === "win32";
	const rg = isWindows ? "rg.exe" : "rg";
	let failures = 0;

	for (const rule of rules) {
		const args = ["-n", "-U", "--pcre2", rule.pattern];
		if (rule.type) {
			args.push("--type", rule.type);
		}
		for (const g of rule.globs ?? []) {
			args.push("--glob", g);
		}
		args.push(...(rule.targets ?? []));
		// shell:false ALWAYS — never `shell:true`. On Windows, routing the regex
		// pattern through cmd.exe mangles it (^ is cmd's escape, ! triggers
		// delayed expansion, char classes / lookarounds get corrupted → PCRE2
		// "missing terminating ]" / "quantifier does not follow a repeatable
		// item"). rg.exe is a real binary; CreateProcess finds it on PATH and
		// passes the pattern argv verbatim.
		const result = spawnSync(rg, args, {
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
			windowsHide: true,
			encoding: "utf8",
		});
		const status = result.status ?? -1;
		// rg exit: 0 = matches found, 1 = no matches, 2 = error.
		if (status === 0) {
			console.error(rule.message);
			console.error(result.stdout?.trimEnd());
			console.error();
			failures = 1;
		} else if (status !== 1) {
			console.error(`[ripcheck] ripgrep scan failed (exit ${status})`);
			if (result.stderr) console.error(result.stderr);
			failures = 1;
		}
	}

	process.exit(failures === 0 ? 0 : 1);
}
