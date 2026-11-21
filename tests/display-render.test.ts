import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderDisplay, type RenderStyle } from "../src/display-render.ts";
import type { DisplayRun } from "../src/display.ts";

// Use the real bundled width/color helpers when Pi is installed, without vendoring it.
let tui: any, ui: any;
try {
	const install = process.env.PI_MANAGED_INSTALL_ROOT || path.join(os.homedir(), ".pi/agent/install");
	const piRoot =
		process.env.PI_DELEGATES_PI_ROOT ||
		path.join(
			install,
			"releases",
			fs.readFileSync(path.join(install, "current-version"), "utf8").trim(),
			"node_modules/@earendil-works/pi-coding-agent",
		);
	const require = createRequire(path.join(piRoot, "package.json"));
	const tuiPath = require.resolve("@earendil-works/pi-tui");
	tui = await import(pathToFileURL(tuiPath).href);
	const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
	const loader = createJiti(import.meta.url, { alias: { "@earendil-works/pi-tui": tuiPath } });
	ui = await loader.import(fileURLToPath(new URL("../src/ui.ts", import.meta.url)));
} catch (error) {
	if (process.env.PI_DELEGATES_TEST_PI) throw error;
}
function rows(): DisplayRun[] {
	return ["thinktank", "thinker", "worker", "prmanager"].map((role, i) => ({
		id: `${i}2345678-1234-1234-1234-123456789012`,
		runId: `run${i}`,
		scopeId: "scope",
		parentRunId: i ? "run0" : undefined,
		name: i ? "研究 🐈 e\u0301 long name " + "x".repeat(50) : "Cat breed history research",
		profile: i === 3 ? "custom-pr" : role,
		role: role as DisplayRun["role"],
		model: "provider/very-long-model-name:high",
		mode: "compact",
		show: true,
		deliveryMode: i === 3 ? "pr" : "none",
		startedAt: 0,
		execution: "running",
		verification: { status: "not-run", checks: [] },
		delivery: { status: "not-requested" },
		success: false,
		selfTurns: 2,
		tools: [],
	}));
}
function theme(appearance: "dark" | "light") {
	return {
		appearance,
		fg: (token: string, text: string) =>
			tui.styleText(
				text,
				{
					fg: tui.parseColor(
						(
							{
								accent: "#00aacc",
								success: "#00aa00",
								warning: "#ccaa00",
								error: "#dd0000",
								muted: "#888888",
							} as Record<string, string>
						)[token],
					),
				},
				"truecolor",
			),
		style: (text: string, options: any) => tui.styleText(text, options, "truecolor"),
	};
}
test("real Pi width helpers keep colored rows within narrow/wide terminal columns", { skip: !tui }, () => {
	for (const width of [1, 10, 40, 80, 120])
		for (const appearance of ["dark", "light"] as const)
			for (const mode of ["compact", "detailed"] as const) {
				const style = ui.renderStyle(theme(appearance), false) as RenderStyle;
				const lines = renderDisplay(rows(), width, style, { now: 42_000, mode });
				assert.ok(lines.length <= 8);
				for (const line of lines) assert.ok(tui.visibleWidth(line) <= width, JSON.stringify({ width, line }));
				assert.doesNotMatch(lines.join("\n"), /not-run|not-requested/);
			}
});
test(
	"type text and status text have independent colors, including custom role profiles",
	{ skip: !tui },
	() => {
		const dark = ui.renderStyle(theme("dark"), false) as RenderStyle;
		const light = ui.renderStyle(theme("light"), false) as RenderStyle;
		assert.equal(new Set(rows().map((r) => dark.profile("label", r.role))).size, 4);
		assert.notEqual(dark.profile("label", "thinker"), light.profile("label", "thinker"));
		assert.notEqual(dark.profile("label", "thinker"), dark.status("label", "error"));
		const r = rows();
		r[1].execution = "failed";
		r[1].finishedAt = 40_000;
		r[1].error = "\x1b[2Jbad\x07";
		const rendered = renderDisplay(r, 120, dark, { now: 42_000 }).join("\n");
		assert.ok(rendered.includes(dark.profile("[thinker]", "thinker")));
		assert.ok(rendered.includes(dark.status("Failed", "error")));
		assert.ok(rendered.includes(dark.profile("[custom-pr]", "prmanager")));
		assert.ok(!rendered.includes("\x1b[2J"));
	},
);
test(
	"bounded layout prioritizes failures and active children, preserves hierarchy, counts overflow",
	{ skip: !tui },
	() => {
		const data = rows();
		for (let i = 4; i < 12; i++)
			data.push({
				...data[1],
				id: `extra${i}`,
				runId: `extra${i}`,
				name: `Child ${i}`,
				execution: "stopped",
				finishedAt: 1000,
				success: true,
			});
		data[11] = { ...data[11], execution: "failed", error: "failed late", success: false };
		const lines = renderDisplay(data, 100, ui.renderStyle(theme("dark"), true), { now: 42_000 });
		assert.ok(lines.length <= 8);
		assert.match(lines.join("\n"), /Child 11/);
		assert.match(lines.join("\n"), /Cat breed history/);
		const displayedJobs = lines.filter((line) => /^\s*[●✓✗!–] /.test(line)).length;
		assert.match(lines.at(-1)!, new RegExp(`${data.length - displayedJobs} more`));
		assert.doesNotMatch(lines.join("\n"), /\x1b/);
	},
);
test(
	"widget survives theme changes and resize without remounts; disposal stops its timer",
	{ skip: !tui },
	() => {
		let currentTheme = theme("dark"),
			component: any,
			tick: (() => void) | undefined;
		let mounts = 0,
			clears = 0,
			renders = 0,
			now = 42_000;
		const context = {
			ui: {
				get theme() {
					return currentTheme;
				},
				setWidget(_key: string, factory?: any) {
					if (factory) {
						mounts++;
						component = factory({ requestRender: () => renders++ }, currentTheme);
					} else {
						clears++;
						component?.dispose();
						component = undefined;
					}
				},
			},
		};
		const widget = new ui.DelegateWidget(context, {
			now: () => now,
			everySecond: (fn: () => void) => {
				tick = fn;
				return 1;
			},
			cancel: () => {
				tick = undefined;
			},
		});
		widget.update(rows());
		assert.equal(mounts, 1);
		assert.ok(tick);
		const dark = component.render(120).join("\n");
		currentTheme = theme("light");
		component.invalidate();
		if (process.env.NO_COLOR !== undefined || process.env.TERM === "dumb")
			assert.doesNotMatch(component.render(120).join("\n"), /\x1b/);
		else assert.notEqual(component.render(120).join("\n"), dark);
		assert.ok(component.render(40).every((line: string) => tui.visibleWidth(line) <= 40));
		now += 1000;
		tick!();
		assert.equal(mounts, 1);
		assert.ok(renders > 1);
		widget.dispose();
		widget.dispose();
		assert.equal(clears, 1);
		assert.equal(tick, undefined);
		widget.update(rows());
		assert.equal(mounts, 1);
	},
);
test(
	"ASCII/no-color mode and expanded final output remain readable without changing data",
	{ skip: !tui },
	() => {
		const lines = renderDisplay(rows(), 120, ui.renderStyle(theme("dark"), true), { ascii: true, now: 1000 });
		assert.doesNotMatch(lines.join("\n"), /[●✓✗–]|\x1b/);
		const result = {
			id: "id",
			profile: "thinker",
			name: "Research",
			success: true,
			execution: "stopped",
			summary: "Complete evidence ".repeat(20),
			delivery: { status: "not-requested" },
		};
		const before = JSON.stringify(result);
		const component = ui.resultComponent(result, "", true, theme("dark"));
		const expanded = component.render(40);
		assert.ok(expanded.every((line: string) => tui.visibleWidth(line) <= 40));
		assert.match(expanded.join(""), /Complete evidence/);
		assert.equal(JSON.stringify(result), before);
	},
);


test("rendered rows put the name last in compact and detailed views", { skip: !tui }, () => {
	const row = { ...rows()[0], name: "amazon-frog-research", execution: "stopped" as const, finishedAt: 1000,
		success: true, startedAt: Number.NaN, selfTurns: 3, totalTurns: 9, contextSnapshot: { tokens: 20000, contextWindow: 100000 } };
	const style = ui.renderStyle(theme("dark"), true);
	for (const mode of ["compact", "detailed"] as const) {
		const lines = renderDisplay([row], 160, style, { heading: false, now: 1000, mode });
		assert.equal(lines[0], "✓ [thinktank] · Done · 3 turns · 20k tok · amazon-frog-research");
		if (mode === "detailed") assert.match(lines[1], /3 turns · tree: 9 turns/);
		assert.doesNotMatch(lines.join("\n"), /self/);
	}
});

test("collapsed results use their own captured metrics without changing structured data", { skip: !tui }, () => {
	const snapshots = rows().slice(0, 2).map((row, i) => ({
		...row, parentRunId: undefined, execution: "stopped", finishedAt: 1000,
		selfTurns: i + 3, contextSnapshot: { tokens: 1000 + i, contextWindow: 10000 },
	}));
	const results = snapshots.map((row) => ({
		id: row.id, name: row.name, profile: row.profile, model: row.model,
		execution: "stopped", success: true, delivery: { status: "not-requested" },
		usage: { turns: 999 },
	}));
	const before = JSON.stringify(results);
	const output = ui.resultComponent(results, "", false, theme("dark"), undefined, snapshots).render(160).join("\n");
	assert.match(output, /3 turns.*1k tok/);
	assert.match(output, /4 turns.*1k tok/);
	assert.doesNotMatch(output, /999 turns/);
	const unknown = ui.resultComponent(results[0], "", false, theme("dark")).render(160).join("\n");
	assert.match(unknown, /turns \?.*ctx \?/);
	assert.equal(JSON.stringify(results), before);
});
