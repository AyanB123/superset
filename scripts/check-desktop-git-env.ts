/**
 * Cross-platform port of scripts/check-desktop-git-env.sh. Scans
 * apps/desktop/src for forbidden direct simple-git usage — callers must go
 * through the shared git-client wrapper that injects the resolved shell PATH.
 */
import { runRipchecks } from "./_ripcheck";

const TARGET = "apps/desktop/src";
const COMMON = [
	"!**/*.test.ts",
	"!apps/desktop/src/lib/trpc/routers/workspaces/utils/git-client.ts",
];

runRipchecks([
	{
		message:
			"[desktop-git-env] Direct runtime imports from simple-git are forbidden. Use getSimpleGitWithShellPath from workspaces/utils/git-client.ts.",
		pattern: "^import(?!\\s+type\\b).*['\"]simple-git['\"]",
		targets: [TARGET],
		globs: COMMON,
	},
	{
		message:
			"[desktop-git-env] Direct simpleGit(...) construction is forbidden outside git-client.ts.",
		pattern: "\\bsimpleGit\\(",
		targets: [TARGET],
		globs: COMMON,
	},
	{
		message:
			"[desktop-git-env] Raw execFile/execFileAsync git calls are forbidden. Use execGitWithShellPath from workspaces/utils/git-client.ts.",
		pattern: "\\bexecFile(?:Async)?\\(\\s*['\"]git['\"]",
		targets: [TARGET],
		globs: COMMON,
	},
	{
		message:
			'[desktop-git-env] execWithShellEnv("git", ...) is forbidden. Use execGitWithShellPath from workspaces/utils/git-client.ts.',
		pattern: "\\bexecWithShellEnv\\(\\s*['\"]git['\"]",
		targets: [TARGET],
		globs: ["!**/*.test.ts"],
	},
]);
