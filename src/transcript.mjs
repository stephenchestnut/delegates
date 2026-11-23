// Readable views of a delegate's Pi JSON event stream. Shared by the widget's activity line and the
// standalone tail viewer. Plain .mjs (typed by transcript.d.mts) so `node` can run the viewer from
// any install location: Node refuses to strip types from files under node_modules.

const CSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
const CONTROL_ALL = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;

/** Model and tool output is untrusted terminal input: drop escapes and control characters. */
export function sanitize(value, multiline = false) {
	const text = String(value ?? "").replace(CSI, "");
	return multiline
		? text.replace(CONTROL, "")
		: text.replace(CONTROL_ALL, " ").replace(/\s+/g, " ").trim();
}
function shorten(text, max) {
	const chars = [...text];
	return chars.length > max ? chars.slice(0, Math.max(0, max - 1)).join("") + "…" : text;
}
const KEYS = ["command", "path", "file_path", "file", "pattern", "query", "url", "name", "task", "code"];
/** The most telling argument of a tool call, unshortened and possibly multi-line. */
function detailOf(args) {
	const a = args;
	if (typeof a === "string") return a;
	if (!a || typeof a !== "object") return "";
	const named = (items) =>
		items
			.map((t) => (t && typeof t.name === "string" ? t.name : ""))
			.filter(Boolean)
			.join(", ");
	if (Array.isArray(a.tasks)) return `${a.tasks.length} tasks${named(a.tasks) ? `: ${named(a.tasks)}` : ""}`;
	if (Array.isArray(a.pages)) return `${a.pages.length} pages`;
	if (typeof a.profile === "string" && typeof a.name === "string") return `[${a.profile}] ${a.name}`;
	for (const key of KEYS) if (typeof a[key] === "string" && a[key].trim()) return a[key];
	const first = Object.values(a).find((v) => typeof v === "string" && v.trim());
	return typeof first === "string" ? first : "";
}
/** One line such as `bash: npm test`. Never throws: presentation must not affect execution. */
export function summarizeCall(name, args, max = 120) {
	let detail = "";
	try {
		detail = sanitize(detailOf(args));
	} catch {
		/* Unreadable arguments still leave the tool name. */
	}
	return shorten(sanitize(name) + (detail ? `: ${detail}` : ""), max);
}
/** The last sentence of an assistant message, for a one-line status. */
export function lastSentence(text, max = 120) {
	const line =
		String(text ?? "")
			.split("\n")
			.map((l) => sanitize(l).replace(/^[#>*\-\s]+/, ""))
			.filter(Boolean)
			.at(-1) ?? "";
	if ([...line].length <= max) return line;
	return shorten(line.split(/(?<=[.!?])\s+/).filter(Boolean).at(-1) ?? line, max);
}

const HANDLED = new Set([
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_end",
	"agent_settled",
]);
function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => (c?.type === "text" ? String(c.text ?? "") : c?.type === "image" ? "[image]" : ""))
		.filter(Boolean)
		.join("\n");
}
function clip(text, maxLines, maxColumns) {
	const lines = sanitize(text, true)
		.split("\n")
		.map((l) => l.replace(/\t/g, "  ").trimEnd())
		.filter((l) => l.trim());
	return {
		lines: lines.slice(0, maxLines).map((l) => shorten(l, maxColumns)),
		more: Math.max(0, lines.length - maxLines),
	};
}
/**
 * Incremental formatter: feed it one JSONL record at a time and write what it returns. Streams text
 * as it arrives, so a live tail and a replay of the same log read the same.
 */
export function createFormatter({ color = false, columns } = {}) {
	// Quoted tool input and output is clipped to the pane rather than wrapped; prose wraps normally.
	const limit = () => Math.max(20, Math.min(200, (columns?.() ?? 204) - 4));
	const wrap = (on, off) => (text) => (color ? `\x1b[${on}m${text}\x1b[${off}m` : text);
	const dim = wrap(2, 22),
		bold = wrap(1, 22),
		cyan = wrap(36, 39),
		red = wrap(31, 39),
		yellow = wrap(33, 39);
	let pending = "",
		stream = "",
		lineStart = true,
		streamed = false,
		users = 0;
	const write = (text) => {
		if (!text) return;
		pending += text;
		lineStart = text.endsWith("\n");
	};
	const closeStream = () => {
		if (!stream) return;
		if (!lineStart) write("\n");
		if (stream === "thinking" && color) pending += "\x1b[22m";
		stream = "";
	};
	const line = (text) => {
		closeStream();
		write(text + "\n");
	};
	const block = (text) => {
		closeStream();
		write("\n" + text + "\n");
	};
	const body = (text, maxLines, style = dim) => {
		const { lines, more } = clip(text, maxLines, limit());
		for (const l of lines) line("    " + style(l));
		if (more) line("    " + dim(`… ${more} more lines`));
	};
	const take = () => {
		const text = pending;
		pending = "";
		return text;
	};
	const handle = (e) => {
		switch (e.type) {
			case "message_update": {
				const u = e.assistantMessageEvent ?? {};
				if (u.type === "text_delta" || u.type === "thinking_delta") {
					const kind = u.type === "text_delta" ? "text" : "thinking";
					const delta = sanitize(u.delta, true);
					if (!delta) return;
					if (stream !== kind) {
						closeStream();
						write("\n");
						if (kind === "thinking" && color) pending += "\x1b[2m";
						stream = kind;
					}
					write(delta);
					if (kind === "text") streamed = true;
				} else if (u.type === "text_end" || u.type === "thinking_end") closeStream();
				return;
			}
			case "message_end": {
				const m = e.message ?? {};
				if (m.role === "user") {
					block(bold(users++ ? "User" : "Task"));
					body(textOf(m.content), 12, (t) => t);
				} else if (m.role === "assistant") {
					closeStream();
					// Providers that do not stream still deliver the text here.
					const text = streamed ? "" : sanitize(textOf(m.content), true).trim();
					if (text) block(text);
					streamed = false;
					if (["error", "aborted"].includes(m.stopReason))
						block(red(`✗ ${sanitize(m.errorMessage) || `Provider ${m.stopReason}`}`));
				}
				return;
			}
			case "tool_execution_start": {
				// Calls issued by a codemode script arrive as their own events, tagged with the parent.
				if (e.parentToolCallId) {
					line(`  ${dim("↳")} ${cyan(sanitize(e.toolName))} ${shorten(sanitize(detailOf(e.args)), limit() - sanitize(e.toolName).length - 1)}`);
					return;
				}
				const detail = sanitize(detailOf(e.args), true).trim();
				const name = cyan(`▶ ${sanitize(e.toolName)}`);
				if (detail.includes("\n")) {
					block(name);
					body(detail, 10);
				} else block(name + (detail ? " " + shorten(detail, 300) : ""));
				return;
			}
			case "tool_execution_end": {
				if (e.parentToolCallId) {
					// Nested results reach the model through the script's own output, shown with the parent.
					if (e.isError) {
						line("    " + red(`✗ ${sanitize(e.toolName)} failed`));
						body(textOf(e.result?.content), 3, red);
					}
					return;
				}
				if (e.isError) line("    " + red("✗ failed"));
				body(textOf(e.result?.content), 6, e.isError ? red : dim);
				if (e.durationMs >= 1000) line("    " + dim(`(${(e.durationMs / 1000).toFixed(1)}s)`));
				return;
			}
			case "agent_settled":
				if (e.aborted) block(yellow("■ aborted"));
		}
	};
	return {
		push(record) {
			if (!record.trim()) return "";
			const type = /^\{"type":"([a-z_]+)"/.exec(record)?.[1];
			// Skip prompts and whole-conversation records without parsing them.
			if (type && !HANDLED.has(type)) return "";
			let event;
			try {
				event = JSON.parse(record);
			} catch {
				event = undefined;
			}
			// The log also holds stderr, which is not JSON.
			if (!event || typeof event !== "object") block(dim(shorten(sanitize(record), 400)));
			else
				try {
					handle(event);
				} catch {
					/* An unexpected record shape must not stop the tail. */
				}
			return take();
		},
		flush() {
			closeStream();
			return take();
		},
	};
}
