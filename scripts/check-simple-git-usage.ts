/**
 * Cross-platform port of scripts/check-simple-git-usage.sh. Forbids direct
 * simple-git usage outside the approved wrappers (desktop git-client.ts and
 * host-service runtime/git/simple-git.ts).
 */
import { runRipchecks } from "./_ripcheck";

const COMMON = [
	"!**/*.test.ts",
	"!**/*.bench.ts",
	"!**/test/**",
	"!apps/desktop/src/lib/trpc/routers/workspaces/utils/git-client.ts",
	"!packages/host-service/src/runtime/git/simple-git.ts",
];

runRipchecks([
	{
		message:
			"[simple-git] Direct runtime imports from simple-git are forbidden. Use apps/desktop git-client.ts or packages/host-service runtime/git/simple-git.ts.",
		pattern: "(?s)import(?!\\s+type\\b)[^;]*from\\s*['\"]simple-git['\"]",
		targets: ["apps", "packages"],
		globs: COMMON,
	},
	{
		message:
			'[simple-git] require("simple-git") is forbidden outside tests and approved wrappers.',
		pattern: "\\brequire\\(\\s*['\"]simple-git['\"]\\s*\\)",
		targets: ["apps", "packages"],
		globs: COMMON,
	},
	{
		message:
			"[simple-git] Direct simpleGit(...) construction is forbidden outside tests and approved wrappers.",
		pattern: "\\bsimpleGit\\(",
		targets: ["apps", "packages"],
		globs: COMMON,
	},
]);
