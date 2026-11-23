import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TailReader } from "../src/tail-reader.mjs";
import { createFormatter, lastSentence, sanitize, summarizeCall } from "../src/transcript.mjs";

const script = fileURLToPath(new URL("../src/tail-view.mjs", import.meta.url));
const record = (value: unknown) => JSON.stringify(value);
const delta = (type: string, text: string) =>
	record({ type: "message_update", assistantMessageEvent: { type, delta: text } });
const events = [
	record({ type: "session", id: "s" }),
	record({ type: "message_end", message: { role: "system", content: "SYSTEM PROMPT" } }),
	record({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Task: count cats" }] } }),
	delta("thinking_delta", "Planning"),
	record({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } }),
	delta("text_delta", "I will "),
	delta("text_delta", "look.\x1b[2J"),
	record({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "I will look." } }),
	record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "I will look." }] } }),
	record({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "npm test" } }),
	record({
		type: "tool_execution_end",
		toolCallId: "a",
		toolName: "bash",
		isError: false,
		durationMs: 2400,
		result: { content: [{ type: "text", text: Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n") }] },
	}),
	record({ type: "tool_execution_start", toolCallId: "c", toolName: "codemode", args: { code: "await tools.read({})" } }),
	record({
		type: "tool_execution_start",
		toolCallId: "c/1",
		parentToolCallId: "c",
		toolName: "read",
		args: { path: "src/a.ts" },
	}),
	record({
		type: "tool_execution_end",
		toolCallId: "c/1",
		parentToolCallId: "c",
		toolName: "read",
		isError: false,
		result: { content: [{ type: "text", text: "NESTED RESULT" }] },
	}),
	record({ type: "tool_execution_end", toolCallId: "c", toolName: "codemode", isError: true, result: { content: [{ type: "text", text: "boom" }] } }),
	"plain stderr line",
	record({ type: "agent_end", messages: [{ role: "assistant", content: "WHOLE CONVERSATION" }] }),
];

test("call summaries pick the telling argument and stay on one bounded line", () => {
	assert.equal(summarizeCall("bash", { command: "npm test\n&& echo done" }), "bash: npm test && echo done");
	assert.equal(summarizeCall("read", { path: "src/runner.ts", limit: 5 }), "read: src/runner.ts");
	assert.equal(summarizeCall("delegate", { profile: "thinker", name: "Siamese", task: "x" }), "delegate: [thinker] Siamese");
	assert.equal(
		summarizeCall("delegate_parallel", { tasks: [{ name: "a" }, { name: "b" }] }),
		"delegate_parallel: 2 tasks: a, b",
	);
	assert.equal(summarizeCall("web_fetch", { pages: [{}, {}, {}] }), "web_fetch: 3 pages");
	assert.equal(summarizeCall("delegate_verify", {}), "delegate_verify");
	assert.equal(summarizeCall("odd", null), "odd");
	assert.equal(summarizeCall("bash", { command: "\x1b[31mred\x07\u202e" }), "bash: red");
	const long = summarizeCall("bash", { command: "x".repeat(500) }, 40);
	assert.equal([...long].length, 40);
	assert.ok(long.endsWith("…"));
	assert.equal(lastSentence("# Plan\n\nFirst thing. Now checking the tests.\n"), "First thing. Now checking the tests.");
	assert.equal(lastSentence(`${"a".repeat(200)}. Short end.`, 40), "Short end.");
	assert.equal(lastSentence(""), "");
	assert.equal(sanitize("a\tb\nc"), "a b c");
	assert.equal(sanitize("a\n\x1b[1mb\x07", true), "a\nb");
});
test("formatter shows task, streamed text, tools and trimmed results; skips prompts and escapes", () => {
	const f = createFormatter();
	const out = events.map((e) => f.push(e)).join("") + f.flush();
	assert.match(out, /Task\n {4}Task: count cats/);
	assert.match(out, /\nPlanning\n/);
	assert.match(out, /\nI will look\.\n/);
	assert.equal(out.match(/I will look/g)?.length, 1, "streamed text is not repeated at message end");
	assert.match(out, /▶ bash npm test\n {4}line 0\n/);
	assert.match(out, /line 5\n {4}… 3 more lines\n {4}\(2\.4s\)/);
	assert.match(out, /▶ codemode await tools\.read\(\{\}\)\n {2}↳ read src\/a\.ts\n {4}✗ failed\n {4}boom/);
	assert.match(out, /plain stderr line/);
	assert.doesNotMatch(out, /SYSTEM PROMPT|WHOLE CONVERSATION|NESTED RESULT|\x1b/);
	// A provider that does not stream still shows its text, once.
	const plain = createFormatter();
	const text = plain.push(
		record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Whole reply" }] } }),
	);
	assert.match(text, /Whole reply/);
	assert.match(
		plain.push(record({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "auth failed" } })),
		/✗ auth failed/,
	);
	assert.match(createFormatter({ color: true }).push(events[9]), /\x1b\[36m▶ bash/);
	const narrow = createFormatter({ columns: () => 30 });
	const clipped = narrow.push(
		record({ type: "tool_execution_end", toolCallId: "a", result: { content: [{ type: "text", text: "y".repeat(90) }] } }),
	);
	assert.ok(clipped.split("\n").every((l) => [...l].length <= 30), clipped);
});
function jobDir(name: string, lines: string[], execution = "stopped") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegates-tail-"));
	fs.writeFileSync(path.join(dir, "child-100.log"), lines.map((l) => l + "\n").join(""));
	fs.writeFileSync(
		path.join(dir, "job.json"),
		JSON.stringify({
			id: "12345678-1234-1234-1234-123456789012",
			profileName: "thinker",
			profile: { model: "test/model" },
			invocation: { name },
			execution,
			delivery: {},
		}),
	);
	return dir;
}
test("viewer replays a recorded job, joins continuation logs in order, and reports the outcome", () => {
	const dir = jobDir("Cat\x1b[2J count", events);
	try {
		// A partial record at a chunk boundary and a later continuation log.
		fs.writeFileSync(path.join(dir, "child-20.log"), delta("text_delta", "EARLIER") + "\n");
		const r = spawnSync(process.execPath, [script, "--job", dir, "--once"], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /^━━ Cat count · \[thinker\] · test\/model · 12345678\n/);
		assert.ok(r.stdout.indexOf("EARLIER") < r.stdout.indexOf("── continued ──"));
		assert.ok(r.stdout.indexOf("── continued ──") < r.stdout.indexOf("Task: count cats"));
		assert.match(r.stdout, /── finished ──\n$/);
		assert.doesNotMatch(r.stdout, /\x1b/);
		assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8" }).status, 2);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
test("the reader follows appended records across byte boundaries and detects continuations and outcome", () => {
	const dir = jobDir("Live", [], "running");
	const file = path.join(dir, "child-100.log"), manifest = path.join(dir, "job.json");
	try {
		const reader = new TailReader(dir);
		assert.equal(reader.poll().status, "Running");
		const bytes = Buffer.from(delta("text_delta", "a 🐈\n") + "\n");
		const split = bytes.indexOf(Buffer.from("🐈")) + 2;
		fs.appendFileSync(file, bytes.subarray(0, split));
		assert.equal(reader.poll().text, "", "don't emit a partial record");
		fs.appendFileSync(file, bytes.subarray(split));
		assert.deepEqual(reader.poll(1), { text: "", more: true, status: "Loading transcript…" });
		assert.match(reader.poll().text, /a 🐈/);
		assert.equal(reader.poll().text, "", "don't replay records on each poll");
		fs.writeFileSync(path.join(dir, "child-200.log"), delta("text_delta", "second attempt") + "\n");
		assert.match(reader.poll().text, /continued[\s\S]*second attempt/);
		fs.writeFileSync(manifest, JSON.stringify({ execution: "failed", error: "\x1b[2Jboom" }));
		assert.deepEqual(reader.poll(), { text: "\n", more: false, status: "failed · boom", complete: true });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
