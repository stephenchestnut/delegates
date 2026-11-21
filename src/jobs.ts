import * as fs from "node:fs";
import * as path from "node:path";
import type { Job } from "./types.ts";
import { inside } from "./workspace.ts";
import { normalizeProfileNames } from "./config.ts";

export const isActive = (job: Job) => job.execution === "preparing" || job.execution === "running";
/** Manifests are private recovery records, not authority against an unrestricted same-user process. */
export class JobStore {
	readonly root: string;
	constructor(agentDir: string) {
		const root = path.join(agentDir, "delegates", "jobs");
		fs.mkdirSync(root, { recursive: true, mode: 0o700 });
		this.root = fs.realpathSync(root);
	}
	dir(id: string): string {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid job ID");
		const dir = path.join(this.root, id);
		try {
			if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("Refusing a symlinked job directory");
		} catch (error: any) {
			if (error.code !== "ENOENT") throw error;
		}
		return dir;
	}
	createDir(id: string): string {
		const dir = this.dir(id);
		fs.mkdirSync(dir, { mode: 0o700 });
		return dir;
	}
	save(job: Job): void {
		const dir = this.dir(job.id);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const temp = path.join(dir, `job.${process.pid}.tmp`);
		fs.writeFileSync(temp, JSON.stringify(job, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(temp, path.join(dir, "job.json"));
	}
	get(id: string): Job {
		const job = JSON.parse(fs.readFileSync(path.join(this.dir(id), "job.json"), "utf8"));
		if (job.version !== 1 || job.id !== id) throw new Error("Invalid job manifest");
		// Keep existing candidates continuable under the renamed role. Do not resolve
		// defaults again: verification/publication policy must remain the frozen snapshot.
		job.config = normalizeProfileNames(job.config);
		job.profile = normalizeProfileNames({ profiles: { saved: job.profile } }).profiles.saved;
		if (job.profileName === "manager") job.profileName = "prmanager";
		if (job.invocation.profile === "manager") job.invocation.profile = "prmanager";
		return job as Job;
	}
	list(): Job[] {
		return fs
			.readdirSync(this.root)
			.filter((id) => /^[a-f0-9-]{36}$/.test(id))
			.flatMap((id) => {
				try {
					return [this.get(id)];
				} catch {
					return [];
				}
			})
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	}
	/** O_EXCL lease also excludes another Pi session from continuing/discarding this workspace. */
	claim(id: string): () => void {
		const file = path.join(this.dir(id), "lease.json");
		try {
			fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
		} catch (e: any) {
			if (e.code !== "EEXIST") throw e;
			throw new Error(`Job ${id} is leased. Inspect/recover it before continuing or discarding.`);
		}
		return () => fs.rmSync(file, { force: true });
	}
	recover(id: string): Job {
		const lease = path.join(this.dir(id), "lease.json");
		if (fs.existsSync(lease)) {
			const { pid } = JSON.parse(fs.readFileSync(lease, "utf8"));
			if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid lease; inspect manually");
			try {
				process.kill(pid, 0);
				throw new Error("Owning process is still alive; cancel it there first");
			} catch (e: any) {
				if (e.code !== "ESRCH") throw e;
			}
			fs.rmSync(lease);
		}
		const job = this.get(id);
		if (isActive(job)) {
			job.execution = "interrupted";
			job.error = "Previous owner exited; no automatic restart or publication";
			this.save(job);
		}
		return job;
	}
	discard(id: string): void {
		const job = this.get(id);
		if (isActive(job)) throw new Error("Cannot discard an active job; cancel/recover first");
		const release = this.claim(id);
		try {
			if (job.workspace.kind === "clone") {
				const root = fs.realpathSync(this.dir(id));
				const owner = JSON.parse(fs.readFileSync(path.join(root, "workspace-owner.json"), "utf8"));
				const expected = path.join(root, "workspace");
				if (
					owner.id !== id ||
					owner.path !== expected ||
					job.workspace.path !== expected ||
					!inside(root, expected) ||
					fs.lstatSync(expected).isSymbolicLink()
				)
					throw new Error("Refusing to discard an unowned workspace");
				fs.rmSync(expected, { recursive: true });
			}
			// Keep the result manifest and logs as an audit trail, not the checkout.
			fs.writeFileSync(path.join(this.dir(id), "discarded"), new Date().toISOString(), { mode: 0o600 });
		} finally {
			release();
		}
	}
}
