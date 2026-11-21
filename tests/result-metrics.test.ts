import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDisplay, type RenderStyle } from "../src/display-render.ts";
import type { DisplayRun } from "../src/display.ts";

const style: RenderStyle = {
	width: (s) => s.length,
	truncate: (s, n) => s.slice(0, n),
	status: (s) => s,
	profile: (s) => s,
	muted: (s) => s,
};

test("normal-width rows retain metrics before a long profile label", () => {
	const row: DisplayRun = {
		id: "one", runId: "run", scopeId: "scope", name: "Research project",
		profile: "a-very-long-custom-profile-name", role: "thinker", model: "model",
		mode: "compact", show: true, deliveryMode: "none", startedAt: 0, finishedAt: 1000,
		execution: "stopped", verification: { status: "not-run", checks: [] },
		delivery: { status: "not-requested" }, success: true, selfTurns: 4,
		contextSnapshot: { tokens: 1234, contextWindow: 10000 }, tools: [],
	};
	const line = renderDisplay([row], 70, style, { heading: false })[0];
	assert.match(line, /Done/);
	assert.match(line, /4 turns/);
	assert.match(line, /1k tok/);
	assert.doesNotMatch(line, /custom-profile/);
});
