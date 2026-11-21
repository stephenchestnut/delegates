import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { HostRuntime, truncate } from "../src/runtime/host.ts";
import { ControlServer, request } from "../src/control.ts";
import { JobStore } from "../src/jobs.ts";
import { fixture } from "./helpers.ts";
import { resolveConfig } from "../src/config.ts";
import { emptyUsage } from "../src/types.ts";
import type { Job } from "../src/types.ts";

test("host runtime bounds output and preserves UTF-8", async () => {
	const r = new HostRuntime();
	try {
		const result = await r.execute({
			executable: process.execPath,
			args: ["-e", "process.stdout.write('🌟'.repeat(1000))"],
			cwd: process.cwd(),
			maxOutputBytes: 101,
		});
		assert.equal(result.truncated, true);
		assert.equal(Buffer.byteLength(result.stdout), 100);
		assert.ok(!result.stdout.includes("�"));
		assert.equal(truncate("🌟x", 3), "");
	} finally {
		await r.shutdown();
	}
});
for (const detached of [false, true])
	test(`abort kills a process and its grandchild (separate group: ${detached})`, async () => {
		const f = await fixture();
		try {
			const pidFile = path.join(f.dir, "pid");
			const abort = new AbortController();
			const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:${detached}});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`;
			const promise = f.runtime.execute({
				executable: process.execPath,
				args: ["-e", code],
				cwd: f.repo,
				signal: abort.signal,
			});
			for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await sleep(10);
			assert.ok(fs.existsSync(pidFile));
			const pid = Number(fs.readFileSync(pidFile, "utf8"));
			abort.abort();
			assert.equal((await promise).interrupted, true);
			let alive = true;
			for (let i = 0; i < 100; i++) {
				try {
					process.kill(pid, 0);
				} catch {
					alive = false;
					break;
				}
				await sleep(10);
			}
			assert.equal(alive, false);
		} finally {
			await f.cleanup();
		}
	});
test("control disconnect cancels attached work; malformed capability rejected", async () => {
	const server = new ControlServer();
	let cancelled = false;
	await server.start(async (r, signal) => {
		if (r.token !== "valid") throw new Error("invalid capability");
		await new Promise<void>((resolve) =>
			signal.addEventListener(
				"abort",
				() => {
					cancelled = true;
					resolve();
				},
				{ once: true },
			),
		);
		return true;
	});
	try {
		await assert.rejects(
			request({ version: 1, socket: server.socket, jobId: "x", token: "wrong" }, "test"),
			/invalid capability/,
		);
		const abort = new AbortController();
		const promise = request(
			{ version: 1, socket: server.socket, jobId: "x", token: "valid" },
			"test",
			{},
			abort.signal,
		);
		await sleep(20);
		abort.abort();
		await assert.rejects(promise, /cancelled/);
		for (let i = 0; i < 50 && !cancelled; i++) await sleep(10);
		assert.equal(cancelled, true);
	} finally {
		await server.close();
	}
});
test("leases prevent duplicate ownership; explicit recovery does not invent completion", async () => {
	const f = await fixture();
	try {
		const store = new JobStore(f.agent),
			id = randomUUID(),
			dir = store.createDir(id);
		const c = resolveConfig();
		const job: Job = {
			version: 1,
			id,
			ownerSession: "test",
			profileName: "worker",
			profile: c.profiles.worker,
			config: c,
			invocation: { profile: "worker", name: "x", task: "x" },
			workspace: { kind: "shared", path: f.repo, cwd: f.repo, source: f.repo },
			execution: "running",
			startedAt: new Date().toISOString(),
			summary: "",
			usage: emptyUsage(),
			verification: { status: "not-run", checks: [] },
			delivery: { status: "not-requested" },
			submissions: 0,
			logDir: dir,
		};
		store.save(job);
		const release = store.claim(id);
		assert.throws(() => store.claim(id), /leased/);
		assert.throws(() => store.recover(id), /still alive/);
		release();
		assert.equal(store.recover(id).execution, "interrupted");
		assert.equal(store.get(id).delivery.status, "not-requested");
		assert.throws(() => store.get("../../escape"), /Invalid job/);
	} finally {
		await f.cleanup();
	}
});
