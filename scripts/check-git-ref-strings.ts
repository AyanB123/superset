/**
 * Cross-platform port of scripts/check-git-ref-strings.sh. Forbids
 * string-prefix checks against `origin/...` shortnames outside the git-refs
 * module — a local branch can legitimately be named `origin/foo`, so
 * `.startsWith("origin/")` misclassifies it as remote-tracking. Use the
 * discriminated ResolvedRef from packages/host-service instead. See
 * packages/host-service/GIT_REFS.md.
 */
import { runRipchecks } from "./_ripcheck";

// V1 desktop tRPC routers are out of scope — see GIT_REFS.md "Open questions".
const V1_EXCLUDE = "!apps/desktop/src/lib/trpc/routers/**";
const COMMON = [
	"!**/*.test.ts",
	"!packages/host-service/src/runtime/git/refs.ts",
	V1_EXCLUDE,
	// The lint scripts themselves mention these patterns in comments/messages;
	// exclude them so a check doesn't flag its own docstring. (The original .sh
	// checks didn't self-match because they weren't `--type ts`.)
	"!scripts/**",
];

runRipchecks([
	{
		message:
			"[git-refs] '.startsWith(\"origin/\")' is forbidden — a local branch can be named 'origin/foo' and would be misclassified. Use ResolvedRef from @superset/host-service/git.",
		pattern: "\\.startsWith\\(\\s*['\"]origin/",
		type: "ts",
		globs: COMMON,
	},
	{
		message:
			"[git-refs] '.replace(\"origin/\", ...)' is forbidden — same misclassification risk. Use ResolvedRef.shortName / .remote instead.",
		pattern: "\\.replace\\(\\s*['\"]origin/",
		type: "ts",
		globs: COMMON,
	},
]);
