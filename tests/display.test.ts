import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "../src/config.ts";
import {
	DisplayTracker,
	active,
	buildRows,
	childProgress,
	clean,
	elapsed,
	historicalRuns,
	plainRows,
	status,
	visibleRuns,
	type DisplayRun,
} from "../src/display.ts";
import { DisplayClock, type Clock } from "../src/display-clock.ts";
import { emptyUsage, type Job } from "../src/types.ts";

export function row(overrides: Partial<DisplayRun> = {}): DisplayRun {
	return {
		id: "12345678-1234-1234-1234-123456789012",
		runId: "root",
		scopeId: "scope",
		name: "Cat breed history",
		profile: "thinktank",
		role: "thinktank",
		model: "openai/test:high",
		mode: "compact",
		show: true,
		deliveryMode: "none",
		startedAt: 0,
		execution: "running",
		verification: { status: "not-run", checks: [] },
		delivery: { status: "not-requested" },
		success: false,
		selfTurns: 2,
		tools: [],
		...overrides,
	};
}
function job(): Job {
	const config = resolveConfig();
	return {
		version: 1,
		id: "job",
		ownerSession: "test",
		profileName: "thinktank",
		profile: config.profiles.thinktank,
		config,
		invocation: { profile: "thinktank", name: "Cats", task: "Research" },
		workspace: { kind: "shared", cwd: "/tmp", path: "/tmp", source: "/tmp" },
		execution: "running",
		startedAt: new Date(0).toISOString(),
		summary: "",
		usage: emptyUsage(),
		verification: { status: "not-run", checks: [] },
		delivery: { status: "not-requested" },
		submissions: 0,
		logDir: "/tmp",
	};
}
test("compact research shows own turns and context, omitting irrelevant details", () => {
	const text = plainRows([row()], 42_000);
	assert.equal(text, "● [thinktank] · Running · 2 turns · ctx ? · 42s · Cat breed history");
	assert.doesNotMatch(text, /not-run|not-requested|openai|12345678/);
	assert.match(plainRows([row()], 42_000, "detailed"), /id: 12345678.*openai\/test:high.*2 turns/);
	assert.equal(elapsed(row(), 124_000), "2m 04s");
	assert.equal(elapsed(row({ execution: "interrupted" }), 124_000), "");
});
test("context estimates and historical unknowns are per run, never aggregated usage", () => {
	const parent = row({ contextSnapshot: { tokens: 1234, contextWindow: 8000 }, totalTurns: 99 });
	const child = row({ runId: "child", parentRunId: "root", selfTurns: 1, contextSnapshot: { tokens: null, contextWindow: 8000 } });
	const text = plainRows([parent, child], 0, "detailed");
	assert.match(text, /2 turns · 1k tok/);
	assert.match(text, /1 turns · ctx \?/);
	const old = job(); old.usage.turns = 99;
	assert.match(plainRows(historicalRuns([old]), 0), /turns \? · ctx \?/);
});
test("detailed rows retain tree turns without a self label", () => {
	const text = plainRows([row({ totalTurns: 8 })], 0, "detailed");
	assert.match(text, /2 turns · tree: 8 turns/);
	assert.doesNotMatch(text, /self/);
});
test("context tokens round to the nearest thousand without a window", () => {
	for (const [tokens, expected] of [[0, "0k tok"], [499, "0k tok"], [500, "1k tok"], [1499, "1k tok"], [1500, "2k tok"]] as const) {
		assert.ok(plainRows([row({ contextSnapshot: { tokens, contextWindow: null } })], 0).includes(expected));
	}
});
test("workflow relevance follows policy, not profile names, and success requires delivery", () => {
	const custom = row({ profile: "experiment", role: "prmanager", deliveryMode: "candidate" });
	assert.equal(status({ ...custom, verification: { status: "running", checks: [] } }).label, "Verifying");
	assert.equal(status({ ...custom, delivery: { status: "publishing" } }).label, "Publishing");
	assert.equal(status({ ...custom, delivery: { status: "checks-pending" } }).tone, "active");
	assert.equal(status({ ...custom, execution: "stopped", finishedAt: 1000 }).label, "Incomplete");
	assert.equal(
		status({
			...custom,
			execution: "stopped",
			finishedAt: 1000,
			success: true,
			delivery: { status: "candidate-ready" },
		}).label,
		"Candidate ready",
	);
	assert.equal(
		status(row({ execution: "failed", delivery: { status: "delivered" }, error: "broken" })).label,
		"Failed",
	);
	assert.equal(status(row({ execution: "cancelled" })).tone, "muted");
	assert.equal(
		status(row({ verification: { status: "blocked", checks: [], error: "unexpected error" } })).label,
		"Needs attention",
	);
});
test("activity comes from observed tools, with safe fallback and direct-child progress", () => {
	assert.equal(status(row({ tools: ["web_search", "codemode"] })).label, "Searching");
	assert.equal(status(row({ tools: ["bash"] })).label, "Running command");
	assert.equal(status(row({ tools: ["read", "web_search"] })).label, "Running tools");
	const child = row({ runId: "child", parentRunId: "root" });
	assert.equal(status(row(), [child]).label, "Coordinating");
	assert.equal(
		childProgress([child, row({ execution: "stopped", finishedAt: 1, success: true })]),
		"1/2 finished",
	);
	assert.equal(childProgress([child, row({ execution: "failed", finishedAt: 1 })]), "1 failed, 1 running");
	const grandchild = row({ runId: "grandchild", parentRunId: "child" });
	assert.equal(buildRows([row(), child, grandchild])[0].progress, "0/1 finished");
});
test("duplicate names disambiguate, while escaped controls and bidi markers are stripped", () => {
	const rows = buildRows([row(), row({ id: "abcdabcd-0000-0000-0000-000000000000", runId: "second" })]);
	assert.match(rows[0].name, /\[12345678\]/);
	assert.match(rows[1].name, /\[abcdabcd\]/);
	assert.equal(
		clean("\x1b[31mhello\x1b[0m\x1b]8;;https://bad\x07world\x1b]8;;\x07\n\u202efake"),
		"helloworld fake",
	);
	assert.doesNotMatch(
		plainRows([row({ error: "\x1b[2Jbad\x07", model: "\x1b[31mmodel" })], 0, "detailed"),
		/\x1b|\x07/,
	);
});
test("retention keeps completed children until parent finishes; continuation excludes old run", () => {
	const child = row({
		runId: "child",
		id: "child",
		parentRunId: "root",
		execution: "stopped",
		finishedAt: 1000,
		success: true,
	});
	assert.equal(visibleRuns([row(), child], 50_000).length, 2);
	const done = row({ execution: "stopped", finishedAt: 50_000, success: true });
	assert.equal(visibleRuns([done, child], 54_999).length, 2);
	assert.equal(visibleRuns([done, child], 55_000).length, 0);
	assert.deepEqual(
		visibleRuns([done, child, row({ runId: "continued", startedAt: 51_000 })], 51_000).map((r) => r.runId),
		["continued"],
	);
});
test("a rejected continuation cannot hide an existing active run with the same job ID", () => {
	const live = row({ persisted: true });
	const rejected = row({
		runId: "rejected",
		persisted: false,
		execution: "failed",
		finishedAt: 1000,
		error: "Job is already active",
	});
	assert.deepEqual(
		visibleRuns([live, rejected], 2000).map((r) => r.runId),
		["root", "rejected"],
	);
	assert.match(plainRows([rejected], 2000, "detailed"), /launch: 12345678/);
});
test("tracker preserves independent snapshots, scope identity, tool activity and self usage", () => {
	const tracker = new DisplayTracker(),
		j = job();
	tracker.start({ id: j.id, runId: "one", scopeId: "first" }, j.invocation, j.profile, j.config, 0);
	tracker.start({ id: "other", runId: "two", scopeId: "second" }, j.invocation, j.profile, j.config, 0);
	tracker.beginTool("one", "a", "web_search");
	assert.equal(tracker.snapshot("first").length, 1);
	assert.equal(status(tracker.snapshot("first")[0]).label, "Searching");
	tracker.endTool("one", "a");
	j.selfUsage = { ...emptyUsage(), turns: 2 };
	j.usage.turns = 10;
	j.execution = "stopped";
	j.finishedAt = new Date(5000).toISOString();
	tracker.update("one", j);
	const snapshot = tracker.snapshot("first");
	assert.equal(snapshot[0].selfTurns, 2);
	assert.equal(snapshot[0].totalTurns, 10);
	snapshot[0].name = "mutated";
	assert.equal(tracker.snapshot("first")[0].name, "Cats");
	assert.equal(historicalRuns([j])[0].selfTurns, 2);
	delete j.selfUsage;
	assert.equal(historicalRuns([j])[0].selfTurns, undefined);
	assert.match(plainRows(historicalRuns([j]), 5000, "detailed"), /10 recorded turns/);
});
test("activity shows the newest running call, falls back to the last note, and ends with the run", () => {
	const tracker = new DisplayTracker(),
		j = job();
	tracker.start({ id: j.id, runId: "one", scopeId: "s" }, j.invocation, j.profile, j.config, 0);
	const activity = () => tracker.snapshot()[0].activity;
	assert.equal(tracker.note("one", "Reading the plan."), true);
	assert.equal(tracker.note("one", "Reading the plan."), false, "unchanged text does not redraw");
	assert.equal(tracker.note("one", ""), false);
	assert.equal(tracker.call("one", "a", "codemode: script"), true);
	assert.equal(tracker.call("one", "a/1", "read: a.ts"), true);
	assert.equal(activity(), "read: a.ts");
	tracker.call("one", "a/1");
	assert.equal(activity(), "codemode: script");
	tracker.call("one", "a");
	assert.equal(activity(), "Reading the plan.");
	assert.equal(tracker.call("missing", "a", "x"), false);
	const rows = buildRows(tracker.snapshot(), 1000);
	assert.equal(rows[0].activity, "Reading the plan.");
	assert.match(plainRows(tracker.snapshot(), 1000), / · Cats · Reading the plan\.$/);
	tracker.call("one", "b", "bash: \x1b[2Jnpm test");
	assert.equal(buildRows(tracker.snapshot(), 1000)[0].activity, "bash: npm test");
	tracker.fail("one", "boom", false);
	assert.equal(activity(), undefined);
	assert.equal(tracker.call("one", "c", "late"), false);
	assert.equal(buildRows([row({ activity: "stale", execution: "stopped", finishedAt: 1 })], 1000)[0].activity, "");
});
test("clock only renders; retains completion, stops while hidden, and disposes idempotently", () => {
	let now = 0,
		mounts = 0,
		clears = 0,
		renders = 0,
		interval: (() => void) | undefined;
	const fake: Clock = {
		now: () => now,
		everySecond: (fn) => {
			interval = fn;
			return 1;
		},
		cancel: () => {
			interval = undefined;
		},
	};
	const clock = new DisplayClock(
		{ mount: () => mounts++, clear: () => clears++, render: () => renders++ },
		fake,
	);
	clock.update([row()]);
	assert.equal(mounts, 1);
	assert.ok(interval);
	now = 1000;
	interval!();
	assert.equal(mounts, 1);
	assert.equal(renders, 2);
	clock.update([row({ execution: "stopped", finishedAt: now, success: true })]);
	now = 5999;
	interval!();
	assert.equal(clears, 0);
	now = 6000;
	interval!();
	assert.equal(clears, 1);
	assert.equal(interval, undefined);
	clock.update([row({ show: false })]);
	assert.equal(interval, undefined);
	clock.update([row()]);
	assert.equal(mounts, 2);
	clock.dispose();
	clock.dispose();
	assert.equal(clears, 2);
	assert.equal(interval, undefined);
	clock.update([row()]);
	assert.equal(mounts, 2);
	assert.equal(active(row()), true);
});
test("display preference validates and defaults to compact without changing legacy settings", () => {
	assert.equal(resolveConfig().display, "compact");
	assert.equal(resolveConfig({ delegates: { display: "detailed" } }).display, "detailed");
	assert.throws(() => resolveConfig({ delegates: { display: "rainbow" } }), /display/);
});
