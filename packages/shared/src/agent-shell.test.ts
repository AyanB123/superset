import { describe, expect, it } from "bun:test";
import {
	__resetAgentShellCache,
	getAgentShell,
	resolveAgentShell,
	resolveAgentShellWin32,
} from "./agent-shell";

/**
 * Builds probe seams from a lookup table: `which` reports a path only for the
 * exact bin name requested; `exists` reports true only for listed paths.
 */
function probes(opts: {
	which?: Record<string, string | null>;
	exists?: ReadonlyArray<string>;
}) {
	return {
		which: (bin: string) => opts.which?.[bin] ?? null,
		exists: (p: string) => opts.exists?.includes(p) ?? false,
	};
}

describe("resolveAgentShellWin32 — probe order", () => {
	it("prefers Git Bash from PATH (where bash.exe)", () => {
		const shell = resolveAgentShellWin32({
			platform: "win32",
			...probes({
				which: { "bash.exe": "C:\\Program Files\\Git\\bin\\bash.exe" },
			}),
		});
		expect(shell).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
	});

	it("falls back to the known Git Bash path when `where` finds nothing", () => {
		const shell = resolveAgentShellWin32({
			platform: "win32",
			...probes({ exists: ["C:\\Program Files\\Git\\bin\\bash.exe"] }),
		});
		expect(shell).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
	});

	it("prefers the first known Git Bash candidate (bin over usr/bin)", () => {
		const shell = resolveAgentShellWin32({
			platform: "win32",
			...probes({
				exists: [
					"C:\\Program Files\\Git\\usr\\bin\\bash.exe",
					"C:\\Program Files\\Git\\bin\\bash.exe",
				],
			}),
		});
		expect(shell).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
	});

	it("falls back to PowerShell 7 (pwsh) before Windows PowerShell", () => {
		const shell = resolveAgentShellWin32({
			platform: "win32",
			...probes({
				which: { pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
			}),
		});
		expect(shell).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
	});

	it("falls back to Windows PowerShell (powershell.exe) when pwsh is absent", () => {
		const shell = resolveAgentShellWin32({
			platform: "win32",
			...probes({
				which: {
					powershell:
						"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
				},
			}),
		});
		expect(shell).toBe(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		);
	});

	it("falls back to COMSPEC when no POSIX/PowerShell shell is present", () => {
		const shell = resolveAgentShellWin32({
			platform: "win32",
			env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
			...probes({}),
		});
		expect(shell).toBe("C:\\Windows\\System32\\cmd.exe");
	});

	it("falls back to bare cmd.exe when COMSPEC is unset", () => {
		const shell = resolveAgentShellWin32({
			platform: "win32",
			env: {},
			...probes({}),
		});
		expect(shell).toBe("cmd.exe");
	});

	it("prefers Git Bash over PowerShell when both are available", () => {
		const shell = resolveAgentShellWin32({
			platform: "win32",
			...probes({
				which: {
					"bash.exe": "C:\\Program Files\\Git\\bin\\bash.exe",
					pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
				},
			}),
		});
		expect(shell).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
	});
});

describe("resolveAgentShell — posix", () => {
	it("returns the account shell when provided", () => {
		const shell = resolveAgentShell({
			platform: "darwin",
			accountShell: "/bin/fish",
		});
		expect(shell).toBe("/bin/fish");
	});

	it("falls back to $SHELL when account shell is null", () => {
		const shell = resolveAgentShell({
			platform: "linux",
			accountShell: null,
			env: { SHELL: "/usr/bin/zsh" },
		});
		expect(shell).toBe("/usr/bin/zsh");
	});

	it("falls back to /bin/sh as last resort", () => {
		const shell = resolveAgentShell({
			platform: "linux",
			accountShell: null,
			env: {},
		});
		expect(shell).toBe("/bin/sh");
	});
});

describe("getAgentShell — caching", () => {
	it("caches the resolved shell for the process lifetime", () => {
		__resetAgentShellCache();
		const first = getAgentShell();
		const second = getAgentShell();
		expect(first).toBe(second);
		__resetAgentShellCache();
	});
});
