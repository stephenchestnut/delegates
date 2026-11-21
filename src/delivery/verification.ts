import { createHash } from "node:crypto";
import * as path from "node:path";
import type { Job, Verification } from "../types.ts";
import type { Runtime } from "../runtime/interface.ts";
import { candidateTree } from "./git.ts";

export const policyHash = (job: Job): string =>
	createHash("sha256").update(JSON.stringify(job.config.environment)).digest("hex");
export async function verify(
	job: Job,
	runtime: Runtime,
	signal: AbortSignal,
	save: () => void,
): Promise<Verification> {
	const v: Verification = { status: "running", checks: [] };
	job.verification = v;
	save();
	try {
		const { checks, exemption } = job.config.environment;
		if (!checks.length && !exemption)
			throw new Error(
				"No verification policy configured. Set environment.checks or an explicit exemption reason.",
			);
		const before = await candidateTree(runtime, job.workspace.path, job.logDir, signal);
		for (const [i, check] of checks.entries()) {
			const log = path.join(job.logDir, `verify-${Date.now()}-${i}.log`);
			const r = await runtime.execute({
				executable: "/bin/sh",
				args: ["-c", check.command],
				cwd: job.workspace.cwd,
				signal,
				timeoutMs: check.timeoutMs,
				log,
			});
			v.checks.push({ name: check.name, code: r.interrupted ? 124 : r.code, log });
			save();
		}
		const after = await candidateTree(runtime, job.workspace.path, job.logDir, signal);
		v.fingerprint = after;
		v.policyHash = policyHash(job);
		v.status = before !== after ? "stale" : v.checks.some((c) => c.code !== 0) ? "failed" : "passed";
		if (v.status === "stale")
			v.error = "Checks changed candidate files. Inspect the changes and verify again.";
	} catch (error) {
		v.status = "blocked";
		v.error = error instanceof Error ? error.message : String(error);
	}
	save();
	return v;
}
