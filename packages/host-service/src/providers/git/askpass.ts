import { randomUUID } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Writes a temp askpass helper that hands a GitHub token to git and returns the
 * absolute path git should set as `GIT_ASKPASS`.
 *
 * Git invokes the askpass path with ONE argument — a prompt such as
 * `Username for 'https://github.com':` or `Password for 'https://github.com':`
 * — and reads the credential back from stdout. The contract this replicates:
 *   - argument starts with `Username`  → echo `x-access-token`
 *     (GitHub's conventional username for token auth over HTTPS)
 *   - anything else (password prompt) → echo the token itself
 *
 * On macOS/Linux we emit a `#!/bin/sh` script and `chmod 0o700` it. On Windows
 * that shebang cannot execute — there is no `/bin/sh` and `chmod` is a no-op on
 * NTFS — so we instead emit a `.cmd` batch file that git invokes via cmd.exe.
 * Cleanup is symmetric: callers `unlink` the returned path, which works on both
 * file types.
 */
export async function writeTempAskpass(token: string): Promise<string> {
	if (process.platform === "win32") {
		// Batch equivalent of the shell `case` below. `@echo off` keeps the
		// control flow out of stdout (git reads only the credential line).
		// `%~1` strips any surrounding quotes git may pass with the prompt;
		// findstr `/B` anchors the match to the start (mirrors `Username*`).
		// GitHub tokens (`ghp_…`, `github_pat_…`) never contain `%`, so no
		// batch variable-expansion escaping is required.
		const filePath = join(tmpdir(), `git-askpass-${randomUUID()}.cmd`);
		const script = `@echo off
echo %~1 | findstr /B /I "Username" >NUL
if not errorlevel 1 (
  echo x-access-token
) else (
  echo ${token}
)
`;
		await writeFile(filePath, script);
		// No chmod on NTFS — git executes `.cmd` via cmd.exe through PATHEXT
		// association, so no executable bit is required.
		return filePath;
	}

	const filePath = join(tmpdir(), `git-askpass-${randomUUID()}.sh`);
	const script = `#!/bin/sh
case "$1" in
  Username*) echo "x-access-token" ;;
  *) echo "${token}" ;;
esac
`;
	await writeFile(filePath, script);
	await chmod(filePath, 0o700);
	return filePath;
}
