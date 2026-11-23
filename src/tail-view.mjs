#!/usr/bin/env node
// Optional standalone transcript replay/follow. Pi's overlay uses the same reader in-process.
import * as path from "node:path";
import { parseArgs } from "node:util";
import { TailReader } from "./tail-reader.mjs";
import { sanitize } from "./transcript.mjs";

try {
	const { values } = parseArgs({ options: { job: { type: "string" }, once: { type: "boolean" } } });
	if (!values.job) throw new Error("Usage: tail-view.mjs --job <job-dir> [--once]");
	const dir = path.resolve(values.job);
	const out = process.stdout;
	const color = !!out.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
	const reader = new TailReader(dir, { color, columns: () => out.columns });
	const job = reader.job();
	const name = sanitize(job?.invocation?.name ?? path.basename(dir));
	const facts = [`[${sanitize(job?.profileName ?? "delegate")}]`, sanitize(job?.profile?.model), sanitize(job?.id).slice(0, 8)];
	out.on("error", () => process.exit(0));
	out.write(`━━ ${name} · ${facts.filter(Boolean).join(" · ")}\n${sanitize(dir)}\n`);
	let lastStatus;
	const tick = () => {
		const { text, more, status, complete } = reader.poll();
		if (text) out.write(text);
		if (!more && status !== lastStatus) {
			if (complete) out.write(`\n── ${status} ──\n`);
			else if (!text && status.startsWith("Waiting")) out.write(`${status}\n`);
			lastStatus = status;
		}
		return more;
	};
	if (values.once) {
		while (tick()) { /* Drain the replay. */ }
		out.write(reader.flush());
	} else {
		tick();
		const timer = setInterval(() => {
			try {
				tick();
			} catch (error) {
				clearInterval(timer);
				console.error(sanitize(error));
				process.exitCode = 1;
			}
		}, 200);
	}
} catch (error) {
	console.error(sanitize(error?.message ?? error));
	process.exitCode = 2;
}
