import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveConfig } from "../src/config.ts";
import { createClone, resolveBase } from "../src/workspace.ts";
import { emptyUsage } from "../src/types.ts";
import type { Job } from "../src/types.ts";
import { git } from "../src/delivery/git.ts";
import { verify } from "../src/delivery/verification.ts";
import { submit } from "../src/delivery/workflow.ts";
import { checkState } from "../src/delivery/github.ts";
import type { Command, CommandResult } from "../src/runtime/interface.ts";
import { fixture, TestRuntime } from "./helpers.ts";

class GitHubStub extends TestRuntime {
	remote = "";
	prs: any[] = [];
	creates = 0;
	pushes = 0;
	failCreateResponse = false;
	failCI = false;
	failPush = false;
	override async execute(c: Command): Promise<CommandResult> {
		const ok = (stdout = "", code = 0) => ({
			code,
			stdout,
			stderr: "",
			interrupted: false,
			truncated: false,
		});
		if (c.executable === "git") {
			const i = c.args.findIndex((a) => a === "push" || a === "fetch");
			if (i >= 0) {
				if (c.args[i] === "push") {
					this.pushes++;
					if (this.failPush) return ok("rejected non-fast-forward", 1);
				}
				const args = [...c.args];
				args[i + 1] = this.remote;
				return super.execute({ ...c, args });
			}
		}
		if (c.executable === "gh") {
			if (c.args[0] === "api") {
				const url = c.args.at(-1)!;
				if (url.includes("/pulls?")) return ok(JSON.stringify(this.prs));
				if (url.includes("/check-runs"))
					return ok(
						JSON.stringify([
							{
								check_runs: [
									{ id: 1, name: "CI", status: "completed", conclusion: this.failCI ? "failure" : "success" },
								],
							},
						]),
					);
				if (url.includes("/statuses")) return ok(JSON.stringify([[]]));
			}
			if (c.args[1] === "create") {
				this.creates++;
				const branch = c.args[c.args.indexOf("--head") + 1];
				this.prs.push({
					number: 1,
					state: "open",
					html_url: "https://github.com/test/repo/pull/1",
					head: { repo: { full_name: "test/repo" }, ref: branch },
					base: { ref: "main" },
				});
				if (this.failCreateResponse) {
					this.failCreateResponse = false;
					return ok("lost create response", 1);
				}
				return ok("https://github.com/test/repo/pull/1");
			}
			if (c.args[1] === "edit") return ok("");
			if (c.args[1] === "view")
				return ok(
					JSON.stringify({
						headRefOid: await git(this, c.cwd, ["rev-parse", "HEAD"]),
						baseRefName: "main",
						state: "OPEN",
					}),
				);
			throw new Error(`Unexpected gh call: ${c.args.join(" ")}`);
		}
		return super.execute(c);
	}
}
async function setup(
	pr = false,
	environment: any = { checks: [{ name: "test", command: "test -f added.txt" }] },
) {
	const f = await fixture();
	const runtime = new GitHubStub();
	runtime.remote = path.join(f.dir, "remote.git");
	await git(runtime, f.repo, ["init", "--bare", runtime.remote]);
	await git(f.runtime, f.repo, ["push", runtime.remote, "HEAD:refs/heads/main"]);
	await git(runtime, f.repo, ["remote", "add", "origin", "https://github.com/test/repo.git"]);
	const config = resolveConfig({
		delegates: {
			profiles: { prmanager: { delivery: pr ? "pr" : "candidate" } },
			environment,
			...(pr ? { publication: { repository: "test/repo", baseBranch: "main", requiredChecks: ["CI"] } } : {}),
		},
	});
	const id = randomUUID(),
		logDir = path.join(f.dir, id);
	fs.mkdirSync(logDir);
	const signal = new AbortController().signal;
	const workspace = await createClone(
		runtime,
		await resolveBase(runtime, f.repo),
		logDir,
		id,
		"test",
		"origin",
		signal,
	);
	const job: Job = {
		version: 1,
		id,
		ownerSession: "test",
		profileName: "prmanager",
		profile: config.profiles.prmanager,
		config,
		invocation: { profile: "prmanager", name: "test", task: "task" },
		workspace,
		execution: "running",
		startedAt: new Date().toISOString(),
		summary: "",
		usage: emptyUsage(),
		verification: { status: "not-run", checks: [] },
		delivery: { status: "not-requested" },
		submissions: 0,
		logDir,
	};
	fs.writeFileSync(path.join(workspace.path, "added.txt"), "candidate\n");
	const states: string[] = [];
	const save = () => states.push(JSON.stringify(job));
	return {
		...f,
		runtime,
		job,
		signal,
		save,
		states,
		async cleanup() {
			await runtime.shutdown();
			await f.cleanup();
		},
	};
}
const notes = { summary: "Implement feature", acceptanceNotes: "Verified acceptance", limitations: [] };

test("verification gates candidate commit and invalidates changed source", async () => {
	const f = await setup();
	try {
		const blocked = await submit(f.job, f.runtime, notes, f.signal, f.save);
		assert.equal(blocked.status, "blocked");
		assert.equal((await verify(f.job, f.runtime, f.signal, f.save)).status, "passed");
		fs.appendFileSync(path.join(f.job.workspace.path, "added.txt"), "changed");
		assert.equal((await submit(f.job, f.runtime, notes, f.signal, f.save)).status, "blocked");
		assert.equal((await verify(f.job, f.runtime, f.signal, f.save)).status, "passed");
		assert.equal((await submit(f.job, f.runtime, notes, f.signal, f.save)).status, "candidate-ready");
		assert.equal(f.runtime.pushes, 0);
		assert.equal(f.runtime.creates, 0);
	} finally {
		await f.cleanup();
	}
});
test("missing checks block and auto-fixing checks produce stale verification", async () => {
	for (const [environment, status] of [
		[{}, "blocked"],
		[{ checks: [{ name: "fix", command: "printf fixed >> added.txt" }] }, "stale"],
	] as const) {
		const f = await setup(false, environment);
		try {
			assert.equal((await verify(f.job, f.runtime, f.signal, f.save)).status, status);
		} finally {
			await f.cleanup();
		}
	}
});
test("scope policy rejects out-of-scope files before committing", async () => {
	const f = await setup(false, { exemption: "Scope fixture", allowedPaths: ["src/"] });
	try {
		await verify(f.job, f.runtime, f.signal, f.save);
		const d = await submit(f.job, f.runtime, notes, f.signal, f.save);
		assert.equal(d.status, "blocked");
		assert.match(d.error!, /outside allowedPaths/);
		assert.equal(d.commitSha, undefined);
	} finally {
		await f.cleanup();
	}
});
test("failed checks never become successful verification", async () => {
	const f = await setup(false, { checks: [{ name: "fail", command: "exit 7" }] });
	try {
		const v = await verify(f.job, f.runtime, f.signal, f.save);
		assert.equal(v.status, "failed");
		assert.equal(v.checks[0].code, 7);
	} finally {
		await f.cleanup();
	}
});
test("PR delivery is idempotent after a lost creation response", async () => {
	const f = await setup(true);
	try {
		await verify(f.job, f.runtime, f.signal, f.save);
		f.runtime.failCreateResponse = true;
		assert.equal((await submit(f.job, f.runtime, notes, f.signal, f.save)).status, "blocked");
		assert.ok(f.job.delivery.pushedSha);
		assert.equal(f.runtime.creates, 1);
		assert.equal((await submit(f.job, f.runtime, notes, f.signal, f.save)).status, "delivered");
		assert.equal(f.runtime.creates, 1);
		assert.equal(f.job.delivery.prUrl, "https://github.com/test/repo/pull/1");
		assert.ok(f.states.some((s) => JSON.parse(s).delivery.status === "checks-pending"));
	} finally {
		await f.cleanup();
	}
});
test("failed CI preserves PR effects but cannot claim delivery; repair updates same PR", async () => {
	const f = await setup(true);
	try {
		await verify(f.job, f.runtime, f.signal, f.save);
		f.runtime.failCI = true;
		assert.equal((await submit(f.job, f.runtime, notes, f.signal, f.save)).status, "pr-open");
		const oldSha = f.job.delivery.commitSha;
		fs.appendFileSync(path.join(f.job.workspace.path, "added.txt"), "repair");
		await verify(f.job, f.runtime, f.signal, f.save);
		f.runtime.failCI = false;
		assert.equal((await submit(f.job, f.runtime, notes, f.signal, f.save)).status, "delivered");
		assert.notEqual(f.job.delivery.commitSha, oldSha);
		assert.equal(f.runtime.creates, 1);
	} finally {
		await f.cleanup();
	}
});
test("push rejection cannot create a PR and preserves local candidate", async () => {
	const f = await setup(true);
	try {
		await verify(f.job, f.runtime, f.signal, f.save);
		f.runtime.failPush = true;
		assert.equal((await submit(f.job, f.runtime, notes, f.signal, f.save)).status, "blocked");
		assert.ok(f.job.delivery.commitSha);
		assert.equal(f.runtime.creates, 0);
	} finally {
		await f.cleanup();
	}
});
test("remote checks reject missing/skipped/neutral/failed, and inspect latest run", () => {
	assert.equal(checkState(["CI"], [], []), "pending");
	for (const conclusion of ["skipped", "neutral", "failure"])
		assert.equal(checkState(["CI"], [{ name: "CI", status: "completed", conclusion }], []), "failed");
	assert.equal(
		checkState(
			["CI"],
			[
				{ id: 1, name: "CI", status: "completed", conclusion: "success" },
				{ id: 2, name: "CI", status: "in_progress" },
			],
			[],
		),
		"pending",
	);
});
