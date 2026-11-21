import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "../src/delivery/git.ts";
import { createClone, resolveBase } from "../src/workspace.ts";
import { parseReview, prepareReview, pullRequest, reviewDiff } from "../src/review.ts";
import type { Command, Runtime } from "../src/runtime/interface.ts";
import { fixture } from "./helpers.ts";

const signal = new AbortController().signal;
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function clone(f: Fixture, name: string, ref = "HEAD") {
	const dir = path.join(f.agent, name);
	fs.mkdirSync(dir);
	const base = await resolveBase(f.runtime, f.repo, ref);
	return { dir, workspace: await createClone(f.runtime, base, dir, "1234abcd", name, "origin", signal) };
}

test("review accepts explicit scopes, and GitHub PR URLs must match origin", () => {
	assert.deepEqual(parseReview({ task: "/review branch main\nFocus on API", base: "feature" }), { kind: "branch", ref: "main", focus: "Focus on API" });
	for (const task of ["review this", "/review", "/review commit --all", "/review branch main extra", "/review uncommitted extra"])
		assert.throws(() => parseReview({ task }), /Start the task/);
	assert.throws(() => parseReview({ task: "/review uncommitted", base: "main" }), /only for branch/);
	const origin = "git@github.com:example/repo.git";
	assert.deepEqual(pullRequest("https://github.com/Example/Repo/pull/42", origin), { number: "42", repo: "example/repo" });
	assert.throws(() => pullRequest("https://github.com/not/example/pull/42", origin), /does not match/);
	assert.throws(() => pullRequest("42", "/tmp/local"), /require a github.com origin/);
});

test("commit and branch review report the pinned comparison, not caller changes", async () => {
	const f = await fixture();
	try {
		const original = await git(f.runtime, f.repo, ["rev-parse", "HEAD"]);
		await git(f.runtime, f.repo, ["switch", "-c", "feature"]);
		fs.writeFileSync(path.join(f.repo, "source.txt"), "feature\n");
		await git(f.runtime, f.repo, ["commit", "-am", "feature"]);
		const head = await git(f.runtime, f.repo, ["rev-parse", "HEAD"]);
		fs.writeFileSync(path.join(f.repo, "source.txt"), "not-in-review\n");
		const commit = await clone(f, "commit");
		const c = await prepareReview(f.runtime, parseReview({ task: `/review commit ${original}` }), commit.workspace, commit.dir, signal);
		assert.equal(c.target, original);
		assert.equal(fs.readFileSync(path.join(commit.workspace.path, "source.txt"), "utf8"), "original\n");
		assert.match((await reviewDiff(f.runtime, commit.workspace.path, c, { view: "patch" }, signal)).outputs[0].text, /\+original/);
		const branch = await clone(f, "branch", "feature");
		const b = await prepareReview(f.runtime, parseReview({ task: "/review branch main", base: "feature" }), branch.workspace, branch.dir, signal);
		assert.equal(b.target, original);
		assert.equal(branch.workspace.baseSha, head);
		const diff = await reviewDiff(f.runtime, branch.workspace.path, b, { view: "patch", file: "source.txt" }, signal);
		assert.match(diff.outputs[0].text, /\+feature/);
		assert.doesNotMatch(diff.outputs[0].text, /not-in-review/);
		for (const file of ["../source.txt", "/etc/passwd", ".git/config", "src/../source.txt"])
			await assert.rejects(reviewDiff(f.runtime, branch.workspace.path, b, { view: "patch", file }, signal), /literal repository-relative/);
		assert.equal(fs.readFileSync(path.join(f.repo, "source.txt"), "utf8"), "not-in-review\n");
	} finally {
		await f.cleanup();
	}
});

test("uncommitted review clones the staged, unstaged, binary, and untracked changes without touching the source", async () => {
	const f = await fixture();
	try {
		fs.writeFileSync(path.join(f.repo, ".gitignore"), "ignore.txt\n");
		await git(f.runtime, f.repo, ["add", ".gitignore"]);
		await git(f.runtime, f.repo, ["commit", "-m", "ignore"]);
		fs.writeFileSync(path.join(f.repo, "source.txt"), "staged  \n");
		const binary = Buffer.from([0, 255, 254, 6, 8, 0]);
		fs.writeFileSync(path.join(f.repo, "content.bin"), binary);
		await git(f.runtime, f.repo, ["add", "source.txt", "content.bin"]);
		fs.writeFileSync(path.join(f.repo, "source.txt"), "unstaged  \n");
		fs.writeFileSync(path.join(f.repo, "src", "untracked file.txt"), "untracked\n");
		fs.writeFileSync(path.join(f.repo, "ignore.txt"), "not reviewed\n");
		const indexPath = path.join(f.repo, ".git", "index");
		const index = fs.readFileSync(indexPath);
		const { dir, workspace } = await clone(f, "uncommitted");
		const review = await prepareReview(f.runtime, parseReview({ task: "/review uncommitted" }), workspace, dir, signal);
		assert.equal(workspace.excludedDirtyChanges, false);
		assert.deepEqual(fs.readFileSync(path.join(workspace.path, "content.bin")), binary);
		assert.equal(fs.readFileSync(path.join(workspace.path, "src", "untracked file.txt"), "utf8"), "untracked\n");
		assert.equal(fs.existsSync(path.join(workspace.path, "ignore.txt")), false);
		const status = await reviewDiff(f.runtime, workspace.path, review, { view: "files" }, signal);
		assert.match(status.outputs[0].text, /\?\? "src\/untracked file.txt"/);
		const diff = await reviewDiff(f.runtime, workspace.path, review, { view: "patch", file: "source.txt" }, signal);
		assert.match(diff.outputs[0].text, /\+staged  \n/);
		assert.match(diff.outputs[1].text, /\+unstaged  \n/);
		assert.deepEqual(fs.readFileSync(indexPath), index);
		assert.equal(fs.readFileSync(path.join(f.repo, "source.txt"), "utf8"), "unstaged  \n");
	} finally {
		await f.cleanup();
	}
});

test("PR review fetches and validates the exact head and base without a push", async () => {
	const f = await fixture();
	try {
		const base = await git(f.runtime, f.repo, ["rev-parse", "HEAD"]);
		await git(f.runtime, f.repo, ["switch", "-c", "pr-head"]);
		fs.writeFileSync(path.join(f.repo, "source.txt"), "pr-only\n");
		await git(f.runtime, f.repo, ["commit", "-am", "PR"]);
		const head = await git(f.runtime, f.repo, ["rev-parse", "HEAD"]);
		await git(f.runtime, f.repo, ["update-ref", "refs/pull/42/head", head]);
		await git(f.runtime, f.repo, ["switch", "main"]);
		await git(f.runtime, f.repo, ["remote", "add", "origin", "https://github.com/example/repo.git"]);
		const { workspace, dir } = await clone(f, "pr");
		let reportedHead = head;
		const runtime: Runtime = {
			kind: "host",
			async execute(cmd: Command) {
				assert.notEqual(cmd.args.includes("push"), true);
				if (cmd.executable === "gh") {
					assert.deepEqual(cmd.args.slice(0, 5), ["pr", "view", "42", "--repo", "github.com/example/repo"]);
					return { code: 0, stdout: JSON.stringify({ baseRefName: "main", baseRefOid: base, headRefOid: reportedHead }), stderr: "", truncated: false, interrupted: false };
				}
				if (cmd.args.includes("fetch")) cmd = { ...cmd, args: cmd.args.map(arg => arg === "origin" ? f.repo : arg) };
				return f.runtime.execute(cmd);
			},
			shutdown: () => f.runtime.shutdown(),
		};
		const request = parseReview({ task: "/review pr 42" });
		const review = await prepareReview(runtime, request, workspace, dir, signal);
		assert.match(review.scope, /PR https:\/\/github.com\/example\/repo\/pull\/42/);
		assert.match((await reviewDiff(runtime, workspace.path, review, { view: "patch" }, signal)).outputs[0].text, /\+pr-only/);
		assert.equal(await git(f.runtime, f.repo, ["rev-parse", "HEAD"]), base);
		reportedHead = base;
		await assert.rejects(prepareReview(runtime, request, workspace, dir, signal), /refs moved/);
	} finally {
		await f.cleanup();
	}
});
