import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as fs from "node:fs";
import type { Command, CommandResult, Runtime } from "./interface.ts";

export function truncate(text: string, bytes: number): string {
	const buffer = Buffer.from(text);
	if (buffer.length <= bytes) return text;
	let end = bytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}
/** Supervise the child group and discoverable descendants. Reparented/daemonized processes are out of scope. */
export class HostRuntime implements Runtime {
	readonly kind = "host";
	private controllers = new Set<AbortController>();
	private pending = new Set<Promise<CommandResult>>();
	execute(command: Command): Promise<CommandResult> {
		const controller = new AbortController();
		this.controllers.add(controller);
		const promise = this.run({
			...command,
			signal: command.signal ? AbortSignal.any([command.signal, controller.signal]) : controller.signal,
		});
		this.pending.add(promise);
		void promise
			.finally(() => {
				this.controllers.delete(controller);
				this.pending.delete(promise);
			})
			.catch(() => {});
		return promise;
	}
	private async run(c: Command): Promise<CommandResult> {
		c.signal?.throwIfAborted();
		if (process.platform === "win32")
			throw new Error("Host runtime currently supports macOS/Linux process-group supervision only");
		const log = c.log ? fs.openSync(c.log, "a", 0o600) : undefined;
		return await new Promise((resolve, reject) => {
			let stdout = "",
				stderr = "",
				interrupted = false,
				truncated = false,
				settled = false;
			let grace: ReturnType<typeof setTimeout> | undefined;
			const limit = c.maxOutputBytes ?? 1_000_000;
			const child = spawn(c.executable, c.args, {
				cwd: c.cwd,
				env: { ...process.env, ...c.env },
				shell: false,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const out = new StringDecoder("utf8"),
				err = new StringDecoder("utf8");
			const groups = new Set<number>();
			if (child.pid) groups.add(child.pid);
			const captureDescendants = () => {
				// Pi's Bash tool creates its own process group. Capture it BEFORE the Pi
				// child exits/reparents its descendants, then retain IDs for escalation.
				const ps = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid="], {
					encoding: "utf8",
					timeout: 1_000,
					maxBuffer: 4_000_000,
				});
				if (ps.status !== 0 || !child.pid) return;
				const rows = ps.stdout
					.trim()
					.split("\n")
					.map((line) => line.trim().split(/\s+/).map(Number));
				const descendants = new Set([child.pid]);
				let changed = true;
				while (changed) {
					changed = false;
					for (const [pid, parent] of rows)
						if (descendants.has(parent) && !descendants.has(pid)) {
							descendants.add(pid);
							changed = true;
						}
				}
				const ownGroup = rows.find(([pid]) => pid === process.pid)?.[2];
				for (const [pid, , group] of rows)
					if (descendants.has(pid) && descendants.has(group) && group !== ownGroup) groups.add(group);
			};
			const killGroup = (signal: NodeJS.Signals) => {
				for (const group of groups)
					try {
						process.kill(-group, signal);
					} catch {
						/* Already exited. */
					}
			};
			const stop = () => {
				if (interrupted) return;
				interrupted = true;
				captureDescendants();
				killGroup("SIGTERM");
				grace = setTimeout(() => killGroup("SIGKILL"), 1_000);
			};
			const timer = setTimeout(stop, c.timeoutMs ?? 600_000);
			const consume = (value: string, isError: boolean) => {
				if (settled) return;
				if (log !== undefined) fs.writeSync(log, value);
				if (!isError) c.onStdout?.(value);
				const previous = isError ? stderr : stdout;
				const next = previous + value;
				if (Buffer.byteLength(next) > limit) truncated = true;
				if (isError) stderr = truncate(next, limit);
				else stdout = truncate(next, limit);
			};
			const finish = (code: number, error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (grace) clearTimeout(grace);
				c.signal?.removeEventListener("abort", stop);
				// A completed command must not leave inherited services alive in its group.
				killGroup("SIGKILL");
				if (log !== undefined) fs.closeSync(log);
				if (error) reject(error);
				else resolve({ code, stdout, stderr, interrupted, truncated });
			};
			c.signal?.addEventListener("abort", stop, { once: true });
			if (c.signal?.aborted) stop();
			child.stdout.on("data", (chunk) => {
				try {
					consume(out.write(chunk), false);
				} catch (e: any) {
					stop();
					finish(1, e);
				}
			});
			child.stderr.on("data", (chunk) => {
				try {
					consume(err.write(chunk), true);
				} catch (e: any) {
					stop();
					finish(1, e);
				}
			});
			child.on("error", (error) => finish(127, error));
			// Kill descendants even if they keep stdio open after the process leader exits.
			child.on("exit", () => killGroup("SIGKILL"));
			child.on("close", (code) => {
				if (settled) return;
				consume(out.end(), false);
				consume(err.end(), true);
				finish(code ?? 1);
			});
		});
	}
	async shutdown(): Promise<void> {
		for (const c of this.controllers) c.abort(new Error("Runtime shutdown"));
		await Promise.allSettled([...this.pending]);
	}
}
export function createRuntime(kind: string): Runtime {
	if (kind !== "host")
		throw new Error(`Runtime '${kind}' is not implemented. Container support is deferred.`);
	return new HostRuntime();
}
