import * as fs from "node:fs";
import * as path from "node:path";
import { git, githubRepository } from "./delivery/git.ts";
import type { Runtime } from "./runtime/interface.ts";
import type { Invocation, Workspace } from "./types.ts";
import { inside } from "./workspace.ts";

export type ReviewRequest = { focus: string } & (
	| { kind: "commit" | "branch" | "pr"; ref: string }
	| { kind: "uncommitted" }
);
export interface PreparedReview {
	args: string;
	focus: string;
	scope: string;
	kind: ReviewRequest["kind"];
	target?: string;
	head?: string;
}

export function parseReview(invocation: Pick<Invocation, "task" | "base">): ReviewRequest {
	const [line, ...rest] = invocation.task.trim().split(/\r?\n/);
	const focus = rest.join("\n").trim();
	if (line === "/review uncommitted" && !invocation.base) return { kind: "uncommitted", focus };
	const match = /^\/review (commit|branch|pr) ([^\s\x00-\x1f\x7f]+)$/.exec(line);
	if (match && !match[2].startsWith("-") && (!invocation.base || match[1] === "branch"))
		return { kind: match[1] as "commit" | "branch" | "pr", ref: match[2], focus };
	throw new Error("Start the task with /review commit REF, /review branch BASE, /review pr NUMBER_OR_URL, or /review uncommitted. The base option is only for branch reviews (it selects the head).");
}

async function reviewGit(runtime: Runtime, cwd: string, args: string[], signal: AbortSignal, maxOutputBytes: number) {
	const r = await runtime.execute({
		executable: "git",
		args: ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--no-pager", "--literal-pathspecs", ...args],
		cwd, signal, maxOutputBytes, timeoutMs: 120_000,
		env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
	});
	if (r.code || r.interrupted) throw new Error(`git ${args[0]} failed: ${r.stderr || `exit ${r.code}`}`);
	return r;
}
const patchFlags = ["--no-ext-diff", "--no-textconv", "--no-color"];

/** Recreate the index and working diff in the clone, without running git add in the source. */
async function snapshot(runtime: Runtime, workspace: Workspace, logDir: string, signal: AbortSignal): Promise<void> {
	const { source, path: clone } = workspace;
	const head = await git(runtime, source, ["rev-parse", "HEAD"], signal);
	if (head !== workspace.baseSha) throw new Error("Source HEAD changed before the uncommitted review snapshot");
	if (/^160000 /m.test(await git(runtime, source, ["ls-files", "--stage"], signal)))
		throw new Error("Uncommitted review snapshots do not support submodules");
	const capture = async (args: string[]) => {
		const result = await reviewGit(runtime, source, args, signal, 16_000_000);
		if (result.truncated) throw new Error("Uncommitted review snapshot is too large; commit the changes and review the commit instead");
		return result.stdout;
	};
	const staged = await capture(["diff", ...patchFlags, "--binary", "--no-renames", "--cached", head, "--"]);
	const unstaged = await capture(["diff", ...patchFlags, "--binary", "--no-renames", "--"]);
	const untracked = (await capture(["ls-files", "-z", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
	for (const [name, patch, flags] of [["staged", staged, ["--index"]], ["unstaged", unstaged, []]] as const) {
		if (!patch) continue;
		const file = path.join(logDir, `review-${name}.patch`);
		fs.writeFileSync(file, patch, { mode: 0o600 });
		try {
			await git(runtime, clone, ["apply", "--whitespace=nowarn", ...flags, "--", file], signal);
		} finally {
			fs.unlinkSync(file);
		}
	}
	for (const entry of untracked) {
		signal.throwIfAborted();
		const from = path.join(source, entry), to = path.join(clone, entry);
		if (!inside(source, from) || !inside(clone, to) || fs.realpathSync(path.dirname(from)) !== path.dirname(from))
			throw new Error(`Unsafe untracked review path: ${entry}`);
		// Git reports gitlinks/nested repos as directories. Do not copy their metadata or follow symlinks.
		const stat = fs.lstatSync(from);
		if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported untracked review path: ${entry}`);
		let dir = clone;
		for (const part of entry.split("/").slice(0, -1)) {
			dir = path.join(dir, part);
			const existing = fs.lstatSync(dir, { throwIfNoEntry: false });
			if (existing && !existing.isDirectory()) throw new Error(`Unsafe snapshot destination: ${entry}`);
			if (!existing) fs.mkdirSync(dir);
		}
		if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
		else fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
	}
	if (await git(runtime, source, ["rev-parse", "HEAD"], signal) !== head)
		throw new Error("Source HEAD changed while capturing the uncommitted review snapshot");
	workspace.excludedDirtyChanges = false;
}

const commitOid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export function pullRequest(ref: string, remoteUrl?: string): { number: string; repo: string } {
	const repo = githubRepository(remoteUrl ?? "");
	if (!repo) throw new Error("PR reviews require a github.com origin remote");
	const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(ref);
	if (url && url[1].toLowerCase() !== repo.toLowerCase()) throw new Error("PR URL does not match the clone's origin repository");
	const number = url?.[2] ?? ref;
	if (!/^[1-9]\d*$/.test(number)) throw new Error("Use a GitHub PR number or a full github.com PR URL");
	return { number, repo };
}

export async function prepareReview(runtime: Runtime, request: ReviewRequest, workspace: Workspace, logDir: string, signal: AbortSignal): Promise<PreparedReview> {
	const { kind, focus } = request;
	const clone = workspace.path;
	const localCommit = async (ref: string) => {
		const sha = await git(runtime, workspace.source, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], signal);
		try {
			await git(runtime, clone, ["cat-file", "-e", `${sha}^{commit}`], signal);
		} catch {
			await git(runtime, clone, ["fetch", "--no-tags", "--", workspace.source, sha], signal);
		}
		return sha;
	};
	const checkout = async (sha: string) => {
		if (workspace.baseSha === sha) return;
		await git(runtime, clone, ["checkout", "--detach", sha], signal);
		workspace.baseSha = sha;
		delete workspace.branch;
	};
	if (kind === "uncommitted") {
		await snapshot(runtime, workspace, logDir, signal);
		return { kind, focus, args: "uncommitted", scope: `Uncommitted snapshot from ${workspace.baseSha}` };
	}
	if (kind === "commit") {
		const sha = await localCommit(request.ref);
		await checkout(sha);
		return { kind, focus, args: `commit ${sha}`, target: sha, scope: `Commit ${sha}` };
	}
	let base: string, scope: string;
	if (kind === "pr") {
		const { number, repo } = pullRequest(request.ref, workspace.remoteUrl);
		const data = await runtime.execute({
			executable: "gh",
			args: ["pr", "view", number, "--repo", `github.com/${repo}`, "--json", "baseRefName,baseRefOid,headRefOid"],
			cwd: clone, signal, timeoutMs: 120_000, env: { GH_PROMPT_DISABLED: "1" },
		});
		if (data.code || data.interrupted || data.truncated) throw new Error(`Cannot read PR #${number}: ${data.stderr}`);
		const { baseRefName, baseRefOid, headRefOid } = JSON.parse(data.stdout);
		if (typeof baseRefName !== "string" || typeof baseRefOid !== "string" || typeof headRefOid !== "string" ||
			!commitOid.test(baseRefOid) || !commitOid.test(headRefOid)) throw new Error("GitHub returned invalid PR refs");
		await git(runtime, clone, ["check-ref-format", `refs/heads/${baseRefName}`], signal);
		await git(runtime, clone, ["-c", "protocol.ext.allow=never", "fetch", "--no-tags", "--no-recurse-submodules", "origin",
			`refs/heads/${baseRefName}:refs/delegates/review/base`, `refs/pull/${number}/head:refs/delegates/review/head`], signal, { GIT_TERMINAL_PROMPT: "0" });
		const fetchedBase = await git(runtime, clone, ["rev-parse", "refs/delegates/review/base"], signal);
		const fetchedHead = await git(runtime, clone, ["rev-parse", "refs/delegates/review/head"], signal);
		if (fetchedBase !== baseRefOid || fetchedHead !== headRefOid)
			throw new Error("PR refs moved during preparation; start a fresh review");
		await checkout(fetchedHead);
		base = fetchedBase;
		scope = `PR https://github.com/${repo}/pull/${number} at ${fetchedHead} against ${baseRefName} (${base})`;
	} else {
		base = await localCommit(request.ref);
		scope = `Branch comparison: ${workspace.baseSha} against ${request.ref} (${base})`;
	}
	const target = await git(runtime, clone, ["merge-base", "HEAD", base], signal);
	return { kind, focus, args: `branch ${base}`, target, scope: `${scope}; merge base ${target}`, head: workspace.baseSha };
}

/** Serve only the prepared comparison; model inputs never become Git commands or revisions. */
export async function reviewDiff(runtime: Runtime, cwd: string, review: PreparedReview, input: unknown, signal: AbortSignal) {
	const args = input as { view?: unknown; file?: unknown } | null;
	if (!args || !["files", "patch", "staged", "unstaged"].includes(args.view as string)) throw new Error("Invalid review diff view");
	const file = args.file;
	if (file !== undefined && (typeof file !== "string" || !file || path.isAbsolute(file) || file.split("/").some(s => !s || s === "." || s === ".." || s === ".git") || /[\x00-\x1f\x7f]/.test(file)))
		throw new Error("Use a literal repository-relative file path");
	const paths = file === undefined ? [] : [file];
	const view = args.view;
	const fmt = view === "files" ? ["--name-status"] : ["--patch"];
	const run = async (cmd: string[]) => {
		const result = await reviewGit(runtime, cwd, cmd, signal, 48_000);
		return { text: result.stdout, truncated: result.truncated };
	};
	const response = (outputs: Awaited<ReturnType<typeof run>>[]) => ({ scope: review.scope, outputs, truncated: outputs.some(o => o.truncated) });
	if (review.kind === "uncommitted") {
		if (view === "files") return response([await run(["status", "--short", "--untracked-files=all", "--", ...paths])]);
		const diff = async (label: string, flags: string[]) => ({ label, ...await run(["diff", ...patchFlags, ...flags, "--", ...paths]) });
		if (view === "staged") return response([await diff("staged", ["--cached"])]);
		if (view === "unstaged") return response([await diff("unstaged", [])]);
		return response([await diff("staged", ["--cached"]), await diff("unstaged", [])]);
	}
	if (view === "staged" || view === "unstaged") throw new Error("Staged and unstaged views are only available for /review uncommitted");
	const files = ["--", ...paths];
	const options = [...patchFlags, ...fmt];
	return response([await run(review.kind === "commit"
		? ["show", "--format=", "--first-parent", "--diff-merges=first-parent", ...options, review.target!, ...files]
		: ["diff", ...options, review.target!, review.head!, ...files])]);
}
