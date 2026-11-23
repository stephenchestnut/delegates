import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import type { Viewer } from "../src/viewer.ts";

let ViewerClass: typeof Viewer | undefined;
try {
	const install = process.env.PI_MANAGED_INSTALL_ROOT || path.join(os.homedir(), ".pi/agent/install");
	const piRoot = process.env.PI_DELEGATES_PI_ROOT || path.join(install, "releases",
		fs.readFileSync(path.join(install, "current-version"), "utf8").trim(), "node_modules/@earendil-works/pi-coding-agent");
	const require = createRequire(path.join(piRoot, "package.json"));
	const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
	const loader = createJiti(import.meta.url, { alias: { "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui") } });
	({ Viewer: ViewerClass } = await loader.import(fileURLToPath(new URL("../src/viewer.ts", import.meta.url))));
} catch (error) {
	if (process.env.PI_DELEGATES_TEST_PI) throw error;
}

const textEvent = (text: string) =>
	JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } }) + "\n";

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegates-overlay-"));
	const fixtureFor = (id: string, initial: string) => {
		const job = path.join(dir, id);
		fs.mkdirSync(job);
		const log = path.join(job, "child-100.log");
		fs.writeFileSync(log, textEvent(initial));
		fs.writeFileSync(path.join(job, "job.json"), JSON.stringify({ execution: "running" }));
		return { target: { id, name: `Job ${id}`, profile: "thinker", dir: job }, append: (text: string) => fs.appendFileSync(log, textEvent(text)) };
	};
	let component: any, options: any, mounts = 0, renders = 0, closes = 0;
	const terminal = { rows: 34 };
	const ctx: any = {
		mode: "tui",
		ui: {
			notify: assert.fail,
			custom(factory: any, opts: any) {
				mounts++;
				options = opts.overlayOptions;
				return new Promise<void>((resolve) => {
					component = factory({ terminal, requestRender: () => renders++ }, { fg: (_: string, text: string) => text }, {}, () => {
						closes++;
					component.dispose();
					resolve();
					});
					queueMicrotask(() => opts.onHandle({
						focus: () => { component.focused = true; },
						unfocus: () => { component.focused = false; },
						isFocused: () => component.focused,
					}));
				});
			},
		},
	};
	const viewer = new ViewerClass!();
	return {
		viewer, ctx, fixtureFor, terminal,
		state: () => ({ component, options, mounts, renders, closes }),
		read: (width = 48) => (component.render(width) as string[]).join("\n"),
		cleanup() {
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("overlay is passive, retargets in place and can be focused, closed and reopened", { skip: !ViewerClass }, async () => {
	const f = fixture();
	try {
		const a = f.fixtureFor("a", "first transcript"), b = f.fixtureFor("b", "second transcript");
		f.viewer.show(f.ctx, a.target);
		await Promise.resolve();
		const { options, component } = f.state();
		assert.deepEqual(options, { anchor: "top-right", width: "50%", maxHeight: "100%", nonCapturing: true });
		assert.equal(f.read().split("\n").length, f.terminal.rows);
		assert.equal(component.focused, false);
		assert.match(f.read(), /Job a · \[thinker\][\s\S]*first transcript/);
		assert.equal(f.viewer.toggleFocus(), true);
		assert.equal(component.focused, true);
		component.handleInput("\t");
		assert.equal(component.focused, false);
		f.viewer.show(f.ctx, b.target);
		assert.equal(f.viewer.viewing(), "b");
		assert.equal(f.state().mounts, 1, "second selection reuses the overlay");
		assert.match(f.read(), /Job b · \[thinker\][\s\S]*second transcript/);
		assert.doesNotMatch(f.read(), /first transcript/);
		f.viewer.toggleFocus();
		component.handleInput("q");
		assert.equal(f.state().closes, 1);
		assert.equal(f.viewer.viewing(), undefined);
		assert.equal(f.viewer.toggleFocus(), false);
		f.viewer.show(f.ctx, a.target);
		await Promise.resolve();
		assert.equal(f.state().mounts, 2);
		assert.equal(f.viewer.viewing(), "a");
		assert.throws(() => f.viewer.show({ ...f.ctx, mode: "rpc" }, b.target), /interactive TUI/);
	} finally {
		f.cleanup();
	}
});

test("overlay follows append, pauses on wheel scroll and resumes with End", { skip: !ViewerClass }, async () => {
	const f = fixture();
	try {
		const a = f.fixtureFor("a", Array.from({ length: 70 }, (_, i) => `line ${i}\n`).join(""));
		f.viewer.show(f.ctx, a.target);
		await Promise.resolve();
		const component = f.state().component;
		assert.match(f.read(), /line 69/);
		assert.deepEqual(component.handleMouse({ type: "wheel", wheelDelta: -5 }), { handled: true });
		const paused = f.read();
		assert.doesNotMatch(paused, /line 69/);
		assert.match(paused, /Paused/);
		a.append("LATEST\n");
		const previousRenders = f.state().renders;
		for (let i = 0; i < 40 && f.state().renders === previousRenders; i++) await sleep(25);
		assert.ok(f.state().renders > previousRenders, "append requests a redraw");
		assert.equal(f.read(), paused, "new output doesn't move a paused viewport");
		component.handleInput("\x1b[F");
		assert.match(f.read(), /LATEST[\s\S]*Live/);
		f.terminal.rows = 25;
		const resized = f.read(26).split("\n");
		assert.equal(resized.length, 25);
		assert.ok(resized.every((line) => stripVTControlCharacters(line).length === 26));
		assert.match(resized.at(-1)!, /^└─+┘$/);
		f.terminal.rows = 3;
		assert.equal(f.read(26).split("\n").length, 3);
		const { renders } = f.state();
		f.viewer.dispose();
		await sleep(250);
		assert.equal(f.state().renders, renders, "closing stops the poll timer");
	} finally {
		f.cleanup();
	}
});
