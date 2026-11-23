import * as fs from "node:fs";
import * as path from "node:path";
import { createFormatter, sanitize } from "./transcript.mjs";

const logName = /^child-(\d+)\.log$/;
const recordLimit = 8_000_000;

function readManifest(dir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8"));
	} catch {
		return undefined;
	}
}

/** Incrementally reads one job's transcript, including later continuation logs. No timers or UI. */
export class TailReader {
	#dir;
	#file;
	#offset = 0;
	#parts = [];
	#size = 0;
	#format;
	#options;
	#buffer = Buffer.allocUnsafe(64 * 1024);
	#manifestKey;
	#job;

	constructor(dir, options = {}) {
		this.#dir = dir;
		this.#options = options;
		this.#format = createFormatter(options);
	}

	#record() {
		const result = this.#size > recordLimit
			? "\n[Oversized log record skipped]\n"
			: this.#format.push(Buffer.concat(this.#parts, this.#size).toString("utf8"));
		this.#parts = [];
		this.#size = 0;
		return result;
	}

	#consume(chunk) {
		let text = "";
		for (let start = 0; start < chunk.length;) {
			const newline = chunk.indexOf(10, start);
			const end = newline < 0 ? chunk.length : newline;
			this.#size += end - start;
			if (this.#size <= recordLimit && end > start) this.#parts.push(Buffer.from(chunk.subarray(start, end)));
			if (newline < 0) break;
			text += this.#record();
			start = end + 1;
		}
		return text;
	}

	/** Read at most budget bytes; more means another poll is needed to reach the end. */
	poll(budget = 512 * 1024) {
		const logs = fs.readdirSync(this.#dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && logName.test(entry.name))
			.map((entry) => entry.name)
			.sort((a, b) => Number(logName.exec(a)[1]) - Number(logName.exec(b)[1]));
		let text = "";
		this.#file ??= logs[0];
		// Hold only an offset between polls. Closing or switching the viewer leaves no open handle.
		while (this.#file) {
			let fd;
			try {
				fd = fs.openSync(path.join(this.#dir, this.#file),
					fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
				if (fs.fstatSync(fd).isFile()) {
					while (budget > 0) {
						const n = fs.readSync(fd, this.#buffer, 0, Math.min(this.#buffer.length, budget), this.#offset);
						if (!n) break;
						this.#offset += n;
						budget -= n;
						text += this.#consume(this.#buffer.subarray(0, n));
					}
				}
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			} finally {
				if (fd !== undefined) fs.closeSync(fd);
			}
			if (budget <= 0) return { text, more: true, status: "Loading transcript…" };
			const timestamp = Number(logName.exec(this.#file)[1]);
			const next = logs.find((log) => Number(logName.exec(log)[1]) > timestamp);
			if (!next) break;
			if (this.#size) text += this.#record();
			text += this.#format.flush() + "\n── continued ──\n";
			this.#format = createFormatter(this.#options);
			this.#file = next;
			this.#offset = 0;
		}
		const job = this.job();
		const active = job && ["running", "preparing"].includes(job.execution);
		const complete = Boolean(job?.execution && !active);
		if (complete) text += this.flush();
		const status = complete
			? [job.execution === "stopped" ? "finished" : sanitize(job.execution),
				sanitize(job.error || job.delivery?.error), sanitize(job.delivery?.prUrl)].filter(Boolean).join(" · ")
			: !this.#file ? "Waiting for the delegate to start…" : job?.execution === "running" ? "Running" : "Following log";
		return { text, more: false, status, complete };
	}

	job() {
		const stat = fs.statSync(path.join(this.#dir, "job.json"), { throwIfNoEntry: false });
		const key = stat?.isFile() ? `${stat.ino}:${stat.mtimeMs}:${stat.size}` : undefined;
		if (key !== this.#manifestKey) {
			this.#manifestKey = key;
			this.#job = key === undefined ? undefined : readManifest(this.#dir);
		}
		return this.#job;
	}

	flush() {
		return (this.#size ? this.#record() : "") + this.#format.flush();
	}
}
