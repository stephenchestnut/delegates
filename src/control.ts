import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Bootstrap } from "./types.ts";

export type RequestHandler = (
	request: { jobId: string; token: string; op: string; args: unknown },
	signal: AbortSignal,
) => Promise<unknown>;
const MAX_MESSAGE = 2_000_000;
/** One request per connection; disconnection cancels attached work. */
export class ControlServer {
	private server?: net.Server;
	private sockets = new Set<net.Socket>();
	private pending = new Set<Promise<unknown>>();
	private dir?: string;
	socket = "";
	async start(handler: RequestHandler): Promise<void> {
		this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dlg-"));
		fs.chmodSync(this.dir, 0o700);
		this.socket = path.join(this.dir, "ctl.sock");
		this.server = net.createServer((socket) => {
			this.sockets.add(socket);
			const controller = new AbortController();
			let buffer = "",
				handled = false;
			socket.setEncoding("utf8");
			socket.on("error", () => {});
			socket.on("close", () => {
				this.sockets.delete(socket);
				controller.abort(new Error("Control client disconnected"));
			});
			socket.on("data", (chunk) => {
				if (handled) return;
				buffer += chunk;
				if (Buffer.byteLength(buffer) > MAX_MESSAGE) {
					socket.destroy();
					return;
				}
				const lineEnd = buffer.indexOf("\n");
				if (lineEnd < 0) return;
				handled = true;
				const work = (async () => {
					try {
						const request = JSON.parse(buffer.slice(0, lineEnd));
						const value = await handler(request, controller.signal);
						socket.end(JSON.stringify({ ok: true, value }) + "\n");
					} catch (error) {
						socket.end(
							JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) +
								"\n",
						);
					}
				})();
				this.pending.add(work);
				void work.finally(() => this.pending.delete(work));
			});
		});
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.socket, resolve);
		});
		fs.chmodSync(this.socket, 0o600);
	}
	async close(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		await Promise.allSettled([...this.pending]);
		if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
		if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
	}
}
export async function request<T>(
	bootstrap: Bootstrap,
	op: string,
	args: unknown = {},
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	return await new Promise<T>((resolve, reject) => {
		const socket = net.createConnection(bootstrap.socket);
		let buffer = "",
			settled = false;
		const cleanup = () => {
			signal?.removeEventListener("abort", abort);
			socket.destroy();
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const abort = () => fail(new Error("Delegate request cancelled"));
		socket.setEncoding("utf8");
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) {
			abort();
			return;
		}
		socket.on("connect", () =>
			socket.write(JSON.stringify({ jobId: bootstrap.jobId, token: bootstrap.token, op, args }) + "\n"),
		);
		socket.on("error", fail);
		socket.on("close", () => fail(new Error("Delegate coordinator disconnected")));
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > MAX_MESSAGE) {
				fail(new Error("Control response too large"));
				return;
			}
			const end = buffer.indexOf("\n");
			if (end < 0) return;
			try {
				const r = JSON.parse(buffer.slice(0, end));
				if (!r.ok) {
					fail(new Error(r.error));
					return;
				}
				settled = true;
				cleanup();
				resolve(r.value);
			} catch (e: any) {
				fail(e);
			}
		});
	});
}
