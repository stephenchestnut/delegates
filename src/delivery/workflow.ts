import * as fs from "node:fs";
import * as path from "node:path";
import type { Delivery, Job } from "../types.ts";
import type { Runtime } from "../runtime/interface.ts";
import { candidateTree, git, githubRepository } from "./git.ts";
import { policyHash } from "./verification.ts";
import { ensurePr, waitForChecks, gh } from "./github.ts";
import { validateWorkspace } from "../workspace.ts";

export interface Submission {
	summary: string;
	acceptanceNotes: string;
	limitations: string[];
}
export function validateSubmission(input: unknown): Submission {
	const s = input as Submission;
	if (
		!s ||
		typeof s !== "object" ||
		Object.keys(s).some((k) => !["summary", "acceptanceNotes", "limitations"].includes(k))
	)
		throw new Error("Invalid submission");
	for (const value of [s.summary, s.acceptanceNotes])
		if (typeof value !== "string" || !value.trim() || value.length > 20_000 || value.includes("\0"))
			throw new Error("Submission needs a summary and acceptance notes (max 20,000 characters each)");
	if (!Array.isArray(s.limitations) || s.limitations.some((x) => typeof x !== "string" || x.length > 5_000))
		throw new Error("limitations must be a string array");
	return s;
}
export async function submit(
	job: Job,
	runtime: Runtime,
	input: Submission,
	signal: AbortSignal,
	save: () => void,
): Promise<Delivery> {
	const s = validateSubmission(input);
	const d = job.delivery;
	try {
		if (++job.submissions > job.config.maxSubmissions)
			throw new Error(
				"Submission budget exhausted; return a blocked report or request explicit continuation",
			);
		save();
		await validateWorkspace(
			runtime,
			job.workspace,
			d.commitSha ?? job.workspace.baseSha!,
			job.config.publication?.remote ?? "origin",
			signal,
		);
		const tree = await candidateTree(runtime, job.workspace.path, job.logDir, signal);
		const scope = job.config.environment.allowedPaths;
		if (scope) {
			const changed = (
				await git(
					runtime,
					job.workspace.path,
					["diff", "--name-only", "-z", job.workspace.baseSha!, tree, "--"],
					signal,
				)
			)
				.split("\0")
				.filter(Boolean);
			const outside = changed.filter(
				(file) => !scope.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry)),
			);
			if (outside.length) throw new Error(`Changes outside allowedPaths: ${outside.join(", ")}`);
		}
		if (
			job.verification.status !== "passed" ||
			job.verification.fingerprint !== tree ||
			job.verification.policyHash !== policyHash(job)
		) {
			job.verification.status = "stale";
			throw new Error("Final candidate has no current passing verification; run delegate_verify");
		}
		if (job.profile.delivery === "pr") {
			const p = job.config.publication;
			if (!p)
				throw new Error("Publication is not authorized. Configure delegates.publication in user settings.");
			if (githubRepository(job.workspace.remoteUrl ?? "")?.toLowerCase() !== p.repository.toLowerCase())
				throw new Error("Workspace remote does not match approved GitHub repository");
			await git(runtime, job.workspace.path, ["fetch", p.remote, `refs/heads/${p.baseBranch}`], signal);
			if (!p.allowUnpublishedBase) {
				const r = await runtime.execute({
					executable: "git",
					args: ["merge-base", "--is-ancestor", job.workspace.baseSha!, "FETCH_HEAD"],
					cwd: job.workspace.path,
					signal,
				});
				if (r.code !== 0 || r.interrupted)
					throw new Error(
						"Starting commit is not contained in the PR base branch; publication could include unrelated commits. Choose a different base or explicitly authorize allowUnpublishedBase.",
					);
			}
		}
		const baseTree = await git(
			runtime,
			job.workspace.path,
			["rev-parse", `${job.workspace.baseSha}^{tree}`],
			signal,
		);
		if (tree === baseTree && !d.commitSha) {
			d.status = "no-changes";
			save();
			return d;
		}
		const headTree = await git(runtime, job.workspace.path, ["rev-parse", "HEAD^{tree}"], signal);
		if (tree !== headTree) {
			await git(runtime, job.workspace.path, ["add", "-A", "--", "."], signal);
			if ((await git(runtime, job.workspace.path, ["write-tree"], signal)) !== tree)
				throw new Error("Candidate changed while staging");
			const title = s.summary.split(/\r?\n/)[0].trim().slice(0, 120);
			await git(
				runtime,
				job.workspace.path,
				["commit", "-m", title, "-m", `Delegates job ${job.id}`],
				signal,
			);
			d.commitSha = await git(runtime, job.workspace.path, ["rev-parse", "HEAD"], signal);
			d.treeSha = await git(runtime, job.workspace.path, ["rev-parse", "HEAD^{tree}"], signal);
			save();
		} else {
			d.commitSha = await git(runtime, job.workspace.path, ["rev-parse", "HEAD"], signal);
			d.treeSha = tree;
			save();
		}
		if (d.treeSha !== tree || (await candidateTree(runtime, job.workspace.path, job.logDir, signal)) !== tree)
			throw new Error("Candidate changed during finalization; verify again");
		delete d.error;
		if (job.profile.delivery === "candidate") {
			d.status = "candidate-ready";
			save();
			return d;
		}
		const p = job.config.publication!;
		d.status = "publishing";
		save();
		await git(
			runtime,
			job.workspace.path,
			["push", p.remote, `${d.commitSha}:refs/heads/${job.workspace.branch}`],
			signal,
		);
		d.pushedSha = d.commitSha;
		save();
		const body = [
			s.summary,
			"",
			"## Acceptance",
			s.acceptanceNotes,
			"",
			"## Verification",
			...job.verification.checks.map((c) => `- ${c.name}: exit ${c.code}`),
			...(job.config.environment.exemption
				? [`- Explicit exemption: ${job.config.environment.exemption}`]
				: []),
			"",
			"## Limitations",
			...(s.limitations.length ? s.limitations.map((x) => `- ${x}`) : ["None reported."]),
			"",
			`Delegates job: ${job.id}`,
			`Candidate: ${d.commitSha}`,
		].join("\n");
		const file = path.join(job.logDir, "pr-body.md");
		fs.writeFileSync(file, body, { mode: 0o600 });
		d.prUrl = await ensurePr(job, runtime, s.summary.split(/\r?\n/)[0].trim().slice(0, 120), file, signal);
		d.status = "pr-open";
		save();
		await waitForChecks(job, runtime, signal, save);
		const finalPr = JSON.parse(
			await gh(
				runtime,
				job.workspace.path,
				[
					"pr",
					"view",
					job.workspace.branch!,
					"--repo",
					p.repository,
					"--json",
					"headRefOid,baseRefName,state",
				],
				signal,
			),
		);
		if (
			finalPr.headRefOid !== d.commitSha ||
			finalPr.baseRefName !== p.baseBranch ||
			finalPr.state !== "OPEN"
		)
			throw new Error(
				"PR identity/state changed after publication; checks do not prove the approved PR candidate",
			);
		d.status = "delivered";
		save();
	} catch (error) {
		d.error = error instanceof Error ? error.message : String(error);
		// Publication effects remain recorded; a CI failure is not an absent PR.
		d.status = d.prUrl ? "pr-open" : "blocked";
		save();
	}
	return d;
}
