import type { Runtime } from "../runtime/interface.ts";
import type { Job } from "../types.ts";
import { setTimeout as sleep } from "node:timers/promises";

export async function gh(
	runtime: Runtime,
	cwd: string,
	args: string[],
	signal: AbortSignal,
): Promise<string> {
	const r = await runtime.execute({ executable: "gh", args, cwd, signal, timeoutMs: 120_000 });
	if (r.code || r.interrupted || r.truncated)
		throw new Error(`gh ${args[0]} failed: ${r.stderr || r.stdout || "interrupted"}`);
	return r.stdout.trim();
}
/** Use repository/head/base identity; replay after create queries before issuing another create. */
export async function ensurePr(
	job: Job,
	runtime: Runtime,
	title: string,
	bodyFile: string,
	signal: AbortSignal,
): Promise<string> {
	const p = job.config.publication!;
	const owner = p.repository.split("/")[0];
	const query = `repos/${p.repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${job.workspace.branch}`)}&base=${encodeURIComponent(p.baseBranch)}`;
	const prs = JSON.parse(await gh(runtime, job.workspace.path, ["api", query], signal));
	if (!Array.isArray(prs)) throw new Error("Invalid PR lookup response");
	const matches = prs.filter(
		(pr: any) =>
			pr.head?.repo?.full_name?.toLowerCase() === p.repository.toLowerCase() &&
			pr.head?.ref === job.workspace.branch &&
			pr.base?.ref === p.baseBranch,
	);
	if (matches.length > 1) throw new Error("Ambiguous existing PR identity");
	if (matches.length) {
		const pr = matches[0];
		if (pr.state !== "open") throw new Error("Assigned PR is closed/merged; start a new prmanager instead");
		await gh(
			runtime,
			job.workspace.path,
			["pr", "edit", String(pr.number), "--repo", p.repository, "--title", title, "--body-file", bodyFile],
			signal,
		);
		return pr.html_url;
	}
	return await gh(
		runtime,
		job.workspace.path,
		[
			"pr",
			"create",
			"--repo",
			p.repository,
			"--base",
			p.baseBranch,
			"--head",
			job.workspace.branch!,
			"--title",
			title,
			"--body-file",
			bodyFile,
		],
		signal,
	);
}
export function checkState(
	required: string[],
	runs: any[],
	statuses: any[],
): "passed" | "failed" | "pending" {
	let pending = false;
	for (const name of required) {
		// APIs return newest first in normal use; explicitly sort to avoid accepting an earlier success.
		const matchingRuns = runs.filter((r) => r.name === name).sort((a, b) => b.id - a.id);
		const matchingStatuses = statuses.filter((s) => s.context === name).sort((a, b) => b.id - a.id);
		const run = matchingRuns[0],
			status = matchingStatuses[0];
		if (!run && !status) {
			pending = true;
			continue;
		}
		if (run) {
			if (run.status !== "completed") pending = true;
			else if (run.conclusion !== "success") return "failed"; // skipped/neutral are not success
		}
		if (status) {
			if (status.state === "pending") pending = true;
			else if (status.state !== "success") return "failed";
		}
	}
	return pending ? "pending" : "passed";
}
export async function waitForChecks(
	job: Job,
	runtime: Runtime,
	signal: AbortSignal,
	save: () => void,
): Promise<void> {
	const p = job.config.publication!;
	if (!p.requiredChecks.length) return;
	job.delivery.status = "checks-pending";
	save();
	const deadline = Date.now() + p.ciTimeoutMs;
	while (Date.now() < deadline) {
		signal.throwIfAborted();
		const prefix = `repos/${p.repository}/commits/${job.delivery.commitSha}`;
		const checkPages = JSON.parse(
			await gh(
				runtime,
				job.workspace.path,
				["api", "--paginate", "--slurp", `${prefix}/check-runs?per_page=100`],
				signal,
			),
		);
		const statusPages = JSON.parse(
			await gh(
				runtime,
				job.workspace.path,
				["api", "--paginate", "--slurp", `${prefix}/statuses?per_page=100`],
				signal,
			),
		);
		const state = checkState(
			p.requiredChecks,
			checkPages.flatMap((p: any) => p.check_runs ?? []),
			statusPages.flat(),
		);
		if (state === "passed") return;
		if (state === "failed")
			throw new Error(
				`Required CI failed for ${job.delivery.commitSha}; inspect the PR, repair and resubmit`,
			);
		await sleep(Math.min(5_000, Math.max(1, deadline - Date.now())), undefined, { signal });
	}
	throw new Error(`Required CI is pending/missing for ${job.delivery.commitSha}; timeout reached`);
}
