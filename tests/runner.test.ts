import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Coordinator } from "../src/runner.ts";
import { resolveConfig } from "../src/config.ts";
import { fixture, TestRuntime } from "./helpers.ts";
import { git } from "../src/delivery/git.ts";

async function setup() {
	const f = await fixture();
	const c = new Coordinator({
		agentDir: f.agent,
		extensionPath: "unused-test-extension",
		sessionId: "test",
		piCommand: {
			executable: process.execPath,
			args: [fileURLToPath(new URL("./fake-pi.mjs", import.meta.url))],
		},
		runtimeFactory: () => new TestRuntime(),
	});
	const config = resolveConfig({
		delegates: {
			profiles: { prmanager: { delivery: "candidate" } },
			environment: { checks: [{ name: "test", command: "test -f new.txt" }] },
		},
	});
	return {
		...f,
		c,
		config,
		async cleanup() {
			await c.shutdown();
			await f.cleanup();
		},
	};
}
test("progress scopes isolate identical names and include only their own descendants", async () => {
	const f = await setup();
	try {
		const a: ReturnType<typeof f.c.displaySnapshot>[] = [],
			b: ReturnType<typeof f.c.displaySnapshot>[] = [];
		const unA = f.c.subscribe((rows) => a.push(rows), "scope-a");
		const unB = f.c.subscribe((rows) => b.push(rows), "scope-b");
		const [manager, thinker] = await Promise.all([
			f.c.run(
				{ profile: "prmanager", name: "Same name", task: "NESTED SUBMIT" },
				f.repo,
				f.config,
				undefined,
				undefined,
				undefined,
				"scope-a",
			),
			f.c.run(
				{ profile: "thinker", name: "Same name", task: "read" },
				f.repo,
				f.config,
				undefined,
				undefined,
				undefined,
				"scope-b",
			),
		]);
		unA();
		unB();
		assert.equal(manager.success, true, manager.error);
		assert.equal(thinker.success, true, thinker.error);
		assert.ok(a.flat().every((r) => r.scopeId === "scope-a" && r.id !== thinker.id));
		assert.ok(b.flat().every((r) => r.scopeId === "scope-b" && r.id === thinker.id));
		assert.ok(a.flat().some((r) => r.tools.includes("write")));
		const final = f.c.displaySnapshot("scope-a");
		assert.equal(final.length, 2);
		assert.ok(final.every((r) => r.finishedAt !== undefined));
		const parent = final.find((r) => r.id === manager.id)!;
		assert.equal(parent.selfTurns, 1);
		assert.equal(parent.totalTurns, 2);
		assert.equal(final.find((r) => r.id !== manager.id)!.parentRunId, parent.runId);
		assert.equal(a.find((rows) => rows.length)![0].execution, "preparing");
	} finally {
		await f.cleanup();
	}
});
test("activity follows the child's own tool calls and prose, and clears when it finishes", async () => {
	const f = await setup();
	try {
		const seen: (string | undefined)[] = [];
		const stop = f.c.subscribe((rows) => {
			if (rows[0] && seen.at(-1) !== rows[0].activity) seen.push(rows[0].activity);
		}, "scope");
		const r = await f.c.run(
			{ profile: "thinker", name: "Activity", task: "ACTIVITY" },
			f.repo,
			f.config,
			undefined,
			undefined,
			undefined,
			"scope",
		);
		stop();
		assert.equal(r.success, true, r.error);
		assert.deepEqual(seen, [
			"Running the tests now.",
			"bash: npm test",
			"read: a.ts",
			"bash: npm test",
			"Running the tests now.",
			"thinker finished; codemode available: true",
			undefined,
		]);
		assert.equal(f.c.displaySnapshot("scope")[0].activity, undefined);
		// Activity is display-only: it is not written to the manifest or returned in results.
		assert.doesNotMatch(fs.readFileSync(path.join(r.logDir, "job.json"), "utf8"), /"activity"/);
		assert.equal("activity" in r, false);
	} finally {
		await f.cleanup();
	}
});
test("continuation gets a new display run without inheriting old child progress", async () => {
	const f = await setup();
	try {
		const first = await f.c.run({ profile: "prmanager", name: "first", task: "NESTED" }, f.repo, f.config);
		const previous = f.c.displaySnapshot().find((r) => r.id === first.id)!;
		const second = await f.c.run(
			{ profile: "prmanager", name: "second", task: "SUBMIT", continue: first.id },
			f.repo,
			f.config,
		);
		assert.equal(second.success, true, second.error);
		const fresh = f.c
			.displaySnapshot()
			.filter((r) => r.id === second.id)
			.at(-1)!;
		assert.notEqual(fresh.runId, previous.runId);
		assert.equal(f.c.displaySnapshot(fresh.scopeId).length, 1);
		assert.equal(fresh.selfTurns, 1);
		assert.equal(fresh.totalTurns, 1);
	} finally {
		await f.cleanup();
	}
});
test("thinker uses controlled tools and rejects escalation over real control channel", async () => {
	const f = await setup();
	try {
		const r = await f.c.run(
			{ profile: "thinker", name: "research", task: "TRY_FORBIDDEN" },
			f.repo,
			f.config,
		);
		assert.equal(r.success, true, r.error);
		assert.match(r.summary, /codemode available: true/);
		assert.equal(r.usage.input, 10);
	} finally {
		await f.cleanup();
	}
});
test("thinktank runs multiple thinkers in caller workspace without Git or publication", async () => {
	const f = await setup();
	try {
		const cwd = path.join(f.dir, "research");
		fs.mkdirSync(cwd);
		fs.writeFileSync(path.join(cwd, "notes.txt"), "unchanged");
		const r = await f.c.run(
			{ profile: "thinktank", name: "cat history", task: "RESEARCH_TEAM" },
			cwd,
			f.config,
		);
		assert.equal(r.success, true, r.error);
		assert.equal(r.workspace.kind, "shared");
		assert.equal(r.workspace.cwd, cwd);
		assert.equal(r.delivery.status, "not-requested");
		assert.equal(r.verification.status, "not-run");
		assert.equal(r.usage.input, 40);
		const thinkers = f.c.store.list().filter((j) => j.parentId === r.id);
		assert.equal(thinkers.length, 3);
		assert.ok(thinkers.every((j) => j.profile.role === "thinker" && j.workspace.cwd === cwd));
		assert.deepEqual(fs.readdirSync(cwd), ["notes.txt"]);
		assert.equal(fs.readFileSync(path.join(cwd, "notes.txt"), "utf8"), "unchanged");
	} finally {
		await f.cleanup();
	}
});
test("thinktank does not occupy a leaf thinker budget slot", async () => {
	const f = await setup();
	try {
		f.config.maxParallel = 1;
		f.config.maxThinkers = 1;
		fs.appendFileSync(path.join(f.repo, "source.txt"), "dirty parent");
		const r = await f.c.run(
			{ profile: "thinktank", name: "bounded research", task: "RESEARCH_TEAM" },
			f.repo,
			f.config,
		);
		assert.equal(r.success, true, r.error);
		assert.equal(r.usage.input, 40);
	} finally {
		await f.cleanup();
	}
});
test("cancelling a thinktank joins all of its thinkers", async () => {
	const f = await setup();
	try {
		const abort = new AbortController();
		const promise = f.c.run(
			{ profile: "thinktank", name: "research wait", task: "RESEARCH_TEAM TEAM_WAIT" },
			f.repo,
			f.config,
			abort.signal,
		);
		for (let i = 0; i < 200 && f.c.store.list().length < 4; i++) await sleep(10);
		assert.equal(f.c.store.list().length, 4);
		abort.abort();
		assert.equal((await promise).execution, "cancelled");
		assert.ok(f.c.store.list().every((j) => j.execution === "cancelled"));
	} finally {
		await f.cleanup();
	}
});
test("historical manager jobs retain frozen policy and continue as prmanager", async () => {
	const f = await setup();
	try {
		const first = await f.c.run(
			{ profile: "prmanager", name: "old job", task: "WRITE_FILE" },
			f.repo,
			f.config,
		);
		const file = path.join(first.logDir, "job.json");
		const old = JSON.parse(fs.readFileSync(file, "utf8"));
		old.profileName = "manager";
		old.profile.role = "manager";
		old.invocation.profile = "manager";
		old.config.profiles.manager = { ...old.config.profiles.prmanager, role: "manager" };
		delete old.config.profiles.prmanager;
		delete old.config.profiles.thinktank;
		fs.writeFileSync(file, JSON.stringify(old));
		const before = fs.readFileSync(file, "utf8");
		const restored = f.c.store.get(first.id);
		assert.equal(restored.profileName, "prmanager");
		assert.equal(restored.profile.role, "prmanager");
		assert.deepEqual(restored.config.environment, old.config.environment);
		assert.equal(fs.readFileSync(file, "utf8"), before);
		const continued = await f.c.run(
			{ profile: "prmanager", name: "renamed job", task: "SUBMIT", continue: first.id },
			f.repo,
			f.config,
		);
		assert.equal(continued.success, true, continued.error);
		assert.equal(continued.workspace.branch, first.workspace.branch);
	} finally {
		await f.cleanup();
	}
});
test("two prmanagers share a pinned base but have separate clones, nested workers and verified local commits", async () => {
	const f = await setup();
	try {
		const rs = await f.c.parallel(
			["  Fix: café / Git..refs@{1}.lock!", "✨?!"].map((name) => ({ profile: "prmanager", name, task: "NESTED SUBMIT" })),
			f.repo,
			f.config,
		);
		assert.equal(rs.length, 2);
		for (const r of rs) {
			assert.equal(r.success, true, r.error);
			assert.equal(r.delivery.status, "candidate-ready");
			assert.equal(r.verification.status, "passed");
			assert.equal(r.usage.input, 20);
		}
		assert.equal(rs[0].workspace.branch, `delegates/fix-café-git-refs-1-lock-${rs[0].id.slice(0, 8)}`);
		assert.equal(rs[1].workspace.branch, `delegates/job-${rs[1].id.slice(0, 8)}`);
		assert.equal(rs[0].workspace.baseSha, rs[1].workspace.baseSha);
		assert.notEqual(rs[0].workspace.path, rs[1].workspace.path);
		assert.equal(fs.existsSync(path.join(f.repo, "new.txt")), false);
		assert.equal(await git(f.runtime, f.repo, ["status", "--porcelain"]), "");
		assert.equal(f.c.store.list().filter((j) => j.profile.role === "worker").length, 2);
	} finally {
		await f.cleanup();
	}
});
test("failed providers are not success even if process exits zero; batch keeps successful sibling", async () => {
	const f = await setup();
	try {
		const rs = await f.c.parallel(
			[
				{ profile: "thinker", name: "bad", task: "FAIL_PROVIDER" },
				{ profile: "thinker", name: "good", task: "read" },
			],
			f.repo,
			f.config,
		);
		assert.equal(rs[0].success, false);
		assert.match(rs[0].error!, /authentication/);
		assert.equal(rs[1].success, true);
	} finally {
		await f.cleanup();
	}
});
test("invalid batch never starts a child; shared writers cannot run as a batch", async () => {
	const f = await setup();
	try {
		await assert.rejects(
			f.c.parallel(
				[
					{ profile: "thinker", name: "ok", task: "read" },
					{ profile: "thinker", name: " ", task: "read" },
				],
				f.repo,
				f.config,
			),
		);
		await assert.rejects(
			f.c.parallel(
				["a", "b"].map((name) => ({ profile: "worker", name, task: "write" })),
				f.repo,
				f.config,
			),
			/separate clones/,
		);
		assert.equal(f.c.store.list().length, 0);
	} finally {
		await f.cleanup();
	}
});
test("dirty base fails explicitly; explicit HEAD excludes dirty work", async () => {
	const f = await setup();
	try {
		fs.writeFileSync(path.join(f.repo, "source.txt"), "dirty\n");
		const failed = await f.c.run(
			{ profile: "prmanager", name: "dirty", task: "WRITE_FILE SUBMIT" },
			f.repo,
			f.config,
		);
		assert.equal(failed.success, false);
		assert.match(failed.error!, /dirty/);
		const r = await f.c.run(
			{ profile: "prmanager", name: "explicit", base: "HEAD", task: "WRITE_FILE SUBMIT" },
			f.repo,
			f.config,
		);
		assert.equal(r.success, true, r.error);
		assert.equal(r.workspace.excludedDirtyChanges, true);
		assert.equal(fs.readFileSync(path.join(r.workspace.path, "source.txt"), "utf8"), "original\n");
	} finally {
		await f.cleanup();
	}
});
test("a prmanager that exits without submit never commits or publishes", async () => {
	const f = await setup();
	try {
		const r = await f.c.run(
			{ profile: "prmanager", name: "unfinished", task: "WRITE_FILE" },
			f.repo,
			f.config,
		);
		assert.equal(r.success, false);
		assert.equal(r.execution, "stopped");
		assert.equal(r.delivery.status, "not-requested");
		assert.equal(await git(f.runtime, r.workspace.path, ["rev-parse", "HEAD"]), r.workspace.baseSha);
	} finally {
		await f.cleanup();
	}
});
test("cancellation retains workspace and releases writer ownership", async () => {
	const f = await setup();
	try {
		const abort = new AbortController();
		const promise = f.c.run(
			{ profile: "worker", name: "wait", task: "WAIT_FOREVER" },
			f.repo,
			f.config,
			abort.signal,
		);
		await sleep(150);
		assert.throws(() => f.c.beginMutation(f.repo, "parent", "write"), /owned/);
		abort.abort();
		const r = await promise;
		assert.equal(r.execution, "cancelled");
		f.c.beginMutation(f.repo, "parent", "write");
		f.c.endMutation(f.repo, "parent", "write");
	} finally {
		await f.cleanup();
	}
});
test("one root slot still permits prmanager → worker → thinker without deadlock", async () => {
	const f = await setup();
	try {
		f.config.maxParallel = 1;
		f.config.maxThinkers = 1;
		const r = await f.c.run(
			{ profile: "prmanager", name: "nested", task: "NESTED_THINKER SUBMIT" },
			f.repo,
			f.config,
		);
		assert.equal(r.success, true, r.error);
		assert.equal(r.usage.input, 30);
	} finally {
		await f.cleanup();
	}
});
test("cancelling a prmanager joins its cancelled child before returning", async () => {
	const f = await setup();
	try {
		const abort = new AbortController();
		const promise = f.c.run(
			{ profile: "prmanager", name: "nested-wait", task: "NESTED_WAIT" },
			f.repo,
			f.config,
			abort.signal,
		);
		for (let i = 0; i < 200 && f.c.store.list().length < 2; i++) await sleep(10);
		assert.equal(f.c.store.list().length, 2);
		abort.abort();
		assert.equal((await promise).execution, "cancelled");
		assert.ok(f.c.store.list().every((j) => j.execution === "cancelled"));
	} finally {
		await f.cleanup();
	}
});
test("continuation reuses owned clone, then explicit discard removes only clone", async () => {
	const f = await setup();
	try {
		const first = await f.c.run(
			{ profile: "prmanager", name: "first", task: "WRITE_FILE" },
			f.repo,
			f.config,
		);
		const next = await f.c.run(
			{ profile: "prmanager", name: "revision", task: "SUBMIT", continue: first.id },
			f.repo,
			f.config,
		);
		assert.equal(next.workspace.path, first.workspace.path);
		assert.equal(next.success, true, next.error);
		f.c.store.discard(next.id);
		assert.equal(fs.existsSync(next.workspace.path), false);
		assert.equal(fs.existsSync(f.repo), true);
	} finally {
		await f.cleanup();
	}
});
