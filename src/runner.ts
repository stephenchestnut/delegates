import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { ControlServer } from "./control.ts";
import { validateInvocation } from "./config.ts";
import { JobStore, isActive } from "./jobs.ts";
import { allowedTools, profilePrompt } from "./profiles.ts";
import { createRuntime, truncate } from "./runtime/host.ts";
import type { Runtime } from "./runtime/interface.ts";
import { createClone, resolveBase, validateWorkspace } from "./workspace.ts";
import type { Base } from "./workspace.ts";
import { candidateTree, git } from "./delivery/git.ts";
import { verify } from "./delivery/verification.ts";
import { parseReview, prepareReview, reviewDiff, type PreparedReview } from "./review.ts";
import { submit, validateSubmission } from "./delivery/workflow.ts";
import { emptyUsage, resultOf } from "./types.ts";
import { DisplayTracker, type DisplayRun, type LaunchIdentity } from "./display.ts";
import { lastSentence, summarizeCall } from "./transcript.mjs";
import type { Bootstrap, ChildContext, Config, DelegateResult, Invocation, Job, Profile } from "./types.ts";

interface Running {
	job: Job;
	controller: AbortController;
	token: string;
	runtime: Runtime;
	ready?: boolean;
	review?: NonNullable<ChildContext["review"]> & PreparedReview;
	reviewError?: string;
}
interface Owner {
	jobId: string;
	key: string;
}
export interface CoordinatorOptions {
	agentDir: string;
	extensionPath: string;
	sessionId: string;
	piCommand: { executable: string; args: string[] };
	onChange?: (jobs: DisplayRun[]) => void;
	resolveModel?: (ref: string) => string;
	runtimeFactory?: (kind: string) => Runtime;
}
/** All descendants use this owner. No process-local imitation of a global budget/lock. */
export class Coordinator {
	readonly store: JobStore;
	private options: CoordinatorOptions;
	private server = new ControlServer();
	private starting?: Promise<void>;
	private active = new Map<string, Running>();
	private completed = new Map<string, Job>();
	private reservations = new Map<string, string>();
	private toolOwners = new Map<string, Owner>();
	private shutdownRequested = false;
	private pending = new Set<Promise<DelegateResult>>();
	private childRuns = new Map<string, Set<Promise<DelegateResult>>>();
	private roots = 0;
	private thinkers = 0;
	private display = new DisplayTracker();
	private listeners = new Map<(jobs: DisplayRun[]) => void, string | undefined>();
	subscribe(listener: (jobs: DisplayRun[]) => void, scopeId?: string): () => void {
		if (this.shutdownRequested) return () => {};
		this.listeners.set(listener, scopeId);
		return () => {
			this.listeners.delete(listener);
		};
	}
	displaySnapshot(scopeId?: string): DisplayRun[] {
		return this.display.snapshot(scopeId);
	}
	private emitDisplay(): void {
		try {
			this.options.onChange?.(this.display.snapshot());
		} catch {
			/* Presentation must not alter execution. */
		}
		for (const [listener, scopeId] of this.listeners) {
			try {
				listener(this.display.snapshot(scopeId));
			} catch {
				/* Disconnected renderer. */
			}
		}
	}
	constructor(options: CoordinatorOptions) {
		this.options = options;
		this.store = new JobStore(options.agentDir);
	}
	private start(): Promise<void> {
		return (this.starting ??= this.server.start(async (r, signal) => {
			const running = this.active.get(r.jobId);
			if (!running || running.token !== r.token) throw new Error("Invalid or expired delegate capability");
			const job = running.job;
			const combined = AbortSignal.any([signal, running.controller.signal]);
			switch (r.op) {
				case "context":
					return this.context(running);
				case "reviewError":
					if (job.profile.role !== "crmanager") throw new Error("Only crmanagers may report review startup errors");
					running.reviewError = String((r.args as { error?: unknown })?.error ?? "Review startup failed");
					return true;
				case "reviewDiff":
					if (job.profile.role !== "crmanager" || !running.review) throw new Error("Only crmanagers may read the prepared review diff");
					return reviewDiff(running.runtime, job.workspace.path, running.review, r.args, combined);
				case "ready":
					running.ready = true;
					return true;
				case "contextUsage": {
					const a = r.args as { tokens?: unknown; contextWindow?: unknown } | null;
					const valid = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
					if (!a || !valid(a.tokens) || !valid(a.contextWindow)) return false;
					job.contextSnapshot = { tokens: a.tokens as number | null, contextWindow: a.contextWindow as number | null };
					this.display.update(job.displayRunId!, job);
					this.emitDisplay();
					return true;
				}
				case "delegate":
					return this.run(r.args, job.workspace.cwd, job.config, combined, job);
				case "parallel":
					return this.parallel(r.args, job.workspace.cwd, job.config, combined, job);
				case "beginTool": {
					const a = r.args as { tool: string; id: string };
					if (!a || typeof a.id !== "string" || !allowedTools(job.profile, job.config).includes(a.tool))
						throw new Error("Tool not permitted by delegate profile");
					if (this.isMutation(job.profile, job.config, a.tool))
						this.beginMutation(job.workspace.path, job.id, a.id);
					this.display.beginTool(job.displayRunId!, a.id, a.tool);
					this.emitDisplay();
					return true;
				}
				case "endTool":
					this.endMutation(job.workspace.path, job.id, String((r.args as any)?.id));
					this.display.endTool(job.displayRunId!, String((r.args as any)?.id));
					this.emitDisplay();
					return true;
				case "verify":
					return this.exclusive(job, async () => {
						await validateWorkspace(
							running.runtime,
							job.workspace,
							job.delivery.commitSha ?? job.workspace.baseSha!,
							job.config.publication?.remote ?? "origin",
							combined,
						);
						return verify(job, running.runtime, combined, () => this.save(job));
					});
				case "submit":
					return this.exclusive(job, () =>
						submit(job, running.runtime, validateSubmission(r.args), combined, () => this.save(job)),
					);
				default:
					throw new Error("Unknown delegate control operation");
			}
		}));
	}
	private context({ job, review }: Running): ChildContext {
		return {
			profile: job.profile,
			config: job.config,
			allowedProfiles: Object.entries(job.config.profiles)
				.filter(([, p]) => job.profile.delegation.includes(p.role))
				.map(([name]) => name),
			allowedTools: allowedTools(job.profile, job.config),
			review,
		};
	}
	private isMutation(profile: Profile, config: Config, tool: string): boolean {
		return (
			profile.permissions === "read-write" &&
			(["bash", "edit", "write"].includes(tool) ||
				config.extensions.some((e) => !e.readOnly && e.tools.includes(tool)))
		);
	}
	/** Parent hooks use these too: a shared worker owns writes until its result is returned. */
	beginMutation(workspace: string, jobId: string, key: string): void {
		const reserved = this.reservations.get(workspace),
			busy = this.toolOwners.get(workspace);
		if (reserved && reserved !== jobId)
			throw new Error("Workspace is owned by a coding worker; yield writes until it finishes");
		if (busy && (busy.jobId !== jobId || busy.key !== key))
			throw new Error("Another tool/verification operation is writing this workspace; await it first");
		const job = this.active.get(jobId)?.job;
		if (job && ["candidate-ready", "delivered"].includes(job.delivery.status))
			throw new Error("Candidate is finalized; use explicit continuation for further changes");
		this.toolOwners.set(workspace, { jobId, key });
	}
	endMutation(workspace: string, jobId: string, key: string): void {
		const owner = this.toolOwners.get(workspace);
		if (owner?.jobId === jobId && owner.key === key) this.toolOwners.delete(workspace);
	}
	private async exclusive<T>(job: Job, operation: () => Promise<T>): Promise<T> {
		if (job.profile.role !== "prmanager") throw new Error("Only prmanagers may verify/submit");
		this.beginMutation(job.workspace.path, job.id, "delivery");
		try {
			return await operation();
		} finally {
			this.endMutation(job.workspace.path, job.id, "delivery");
		}
	}
	private save(job: Job): void {
		this.store.save(job);
		if (job.displayRunId) this.display.update(job.displayRunId, job);
		this.emitDisplay();
	}
	private async workspaceKey(runtime: Runtime, cwd: string): Promise<string> {
		try {
			return fs.realpathSync(await git(runtime, cwd, ["rev-parse", "--show-toplevel"]));
		} catch {
			return fs.realpathSync(cwd);
		}
	}
	async parallel(
		input: unknown,
		cwd: string,
		config: Config,
		signal?: AbortSignal,
		parent?: Job,
		scopeId = this.display.scopeOf(parent?.displayRunId) ?? randomUUID(),
	): Promise<DelegateResult[]> {
		if (this.shutdownRequested) throw new Error("Delegates coordinator is shutting down");
		if (!Array.isArray(input) || !input.length || input.length > 32)
			throw new Error("tasks must contain 1–32 invocations");
		const invocations = input.map((i) => validateInvocation(i, config, parent?.profile));
		if (
			invocations.filter(
				(i) =>
					config.profiles[i.profile].workspace === "shared" &&
					config.profiles[i.profile].permissions === "read-write",
			).length > 1
		)
			throw new Error("Parallel writable tasks need separate clones; use prmanagers, not shared workers");
		if (invocations.some((i) => i.continue))
			throw new Error("Continue retained jobs individually, not as a new common-base batch");
		const cloneTasks = invocations.filter((i) => config.profiles[i.profile].workspace === "clone");
		if (new Set(cloneTasks.map((i) => i.base ?? "HEAD")).size > 1)
			throw new Error("A batch must use one common base");
		const runtime = createRuntime("host");
		let base: Base | undefined;
		try {
			if (cloneTasks.length) {
				const allReview = cloneTasks.every(i => config.profiles[i.profile].role === "crmanager");
				base = await resolveBase(runtime, cwd, cloneTasks[0].base ?? (allReview ? "HEAD" : undefined));
			}
		} finally {
			await runtime.shutdown();
		}
		const results: DelegateResult[] = new Array(invocations.length);
		let next = 0;
		const count = Math.min(config.maxParallel, invocations.length);
		await Promise.all(
			Array.from({ length: count }, async () => {
				while (next < invocations.length) {
					const index = next++;
					try {
						results[index] = await this.run(invocations[index], cwd, config, signal, parent, base, scopeId);
					} catch (error) {
						const invocation = invocations[index];
						results[index] = {
							id: randomUUID(),
							name: invocation.name,
							profile: invocation.profile,
							model: config.profiles[invocation.profile].model,
							execution: signal?.aborted ? "cancelled" : "failed",
							success: false,
							summary: "",
							error: String(error),
							workspace: { kind: "shared", path: cwd, cwd, source: cwd },
							verification: { status: "not-run", checks: [] },
							delivery: { status: "not-requested" },
							usage: emptyUsage(),
							logDir: "",
						};
					}
				}
			}),
		);
		return results;
	}
	run(
		input: unknown,
		cwd: string,
		config: Config,
		signal?: AbortSignal,
		parent?: Job,
		base?: Base,
		scopeId = this.display.scopeOf(parent?.displayRunId) ?? randomUUID(),
	): Promise<DelegateResult> {
		if (this.shutdownRequested) return Promise.reject(new Error("Delegates coordinator is shutting down"));
		const invocation = validateInvocation(input, config, parent?.profile);
		const launch: LaunchIdentity = {
			id: invocation.continue ?? randomUUID(),
			runId: randomUUID(),
			scopeId,
			parentRunId: parent?.displayRunId,
		};
		this.display.start(launch, invocation, config.profiles[invocation.profile], config);
		this.emitDisplay();
		const promise = this.runValidated(
			invocation,
			cwd,
			JSON.parse(JSON.stringify(config)),
			launch,
			signal,
			parent,
			base,
		).catch((error) => {
			this.display.fail(launch.runId, error, signal?.aborted ?? false);
			this.emitDisplay();
			throw error;
		});
		this.pending.add(promise);
		if (parent) {
			if (!this.childRuns.has(parent.id)) this.childRuns.set(parent.id, new Set());
			this.childRuns.get(parent.id)!.add(promise);
		}
		void promise
			.finally(() => {
				this.pending.delete(promise);
				if (parent) this.childRuns.get(parent.id)?.delete(promise);
			})
			.catch(() => {});
		return promise;
	}
	private async runValidated(
		invocation: Invocation,
		cwd: string,
		config: Config,
		launch: LaunchIdentity,
		signal?: AbortSignal,
		parent?: Job,
		base?: Base,
	): Promise<DelegateResult> {
		if (this.shutdownRequested) throw new Error("Delegates coordinator is shutting down");
		await this.start();
		const currentPublication = config.publication;
		let profile = { ...config.profiles[invocation.profile] };
		const modelRef = invocation.model ?? profile.model;
		profile.model =
			modelRef === "inherit" && parent
				? parent.profile.model
				: (this.options.resolveModel?.(modelRef) ?? modelRef);
		const runtime = (this.options.runtimeFactory ?? createRuntime)(profile.runtime);
		const controller = new AbortController();
		const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
		const id = launch.id;
		let release: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
		let countedRoot = false,
			countedThinker = false,
			reserved = false;
		let job: Job;
		try {
			if (invocation.continue) {
				if (parent) throw new Error("Only the top-level caller may continue retained work");
				job = this.store.get(id);
				if (isActive(job))
					throw new Error("Job is active/interrupted; inspect or recover before continuation");
				if (job.workspace.kind !== "clone")
					throw new Error("Only retained clone workspaces can be continued");
				if (job.profileName !== invocation.profile)
					throw new Error("Continuation must use the original profile");
				// Preserve the launch policy so continuation cannot silently weaken required checks.
				config = job.config;
				profile = { ...job.profile, model: profile.model };
				if (JSON.stringify(config.publication) !== JSON.stringify(currentPublication))
					throw new Error("Publication authorization changed; review the retained job before continuing");
				release = this.store.claim(id);
				const owner = JSON.parse(
					fs.readFileSync(path.join(this.store.dir(id), "workspace-owner.json"), "utf8"),
				);
				if (
					owner.id !== id ||
					owner.path !== job.workspace.path ||
					owner.path !== path.join(this.store.dir(id), "workspace") ||
					fs.lstatSync(owner.path).isSymbolicLink() ||
					fs.realpathSync(job.workspace.source) !== (await this.workspaceKey(runtime, cwd))
				)
					throw new Error("Continuation workspace/source identity mismatch");
				job.profile = profile;
				job.invocation = invocation;
				job.execution = "preparing";
				job.startedAt = new Date().toISOString();
				job.finishedAt = undefined;
				job.error = undefined;
				job.summary = "";
				job.submissions = 0;
				job.usage = emptyUsage();
				job.verification = { status: "not-run", checks: [] };
				job.delivery.status = "not-requested";
				job.ownerSession = this.options.sessionId;
			} else {
				const dir = this.store.createDir(id);
				release = this.store.claim(id);
				const key = await this.workspaceKey(runtime, cwd);
				job = {
					version: 1,
					id,
					parentId: parent?.id,
					ownerSession: this.options.sessionId,
					profileName: invocation.profile,
					profile,
					config,
					invocation,
					workspace: { kind: "shared", path: key, cwd, source: key },
					execution: "preparing",
					startedAt: new Date().toISOString(),
					summary: "",
					usage: emptyUsage(),
					verification: { status: "not-run", checks: [] },
					delivery: { status: "not-requested" },
					submissions: 0,
					logDir: dir,
				};
			}
		} catch (error) {
			release?.();
			await runtime.shutdown();
			throw error;
		}
		job.displayRunId = launch.runId;
		job.displayParentRunId = launch.parentRunId;
		job.selfUsage = emptyUsage();
		delete job.contextSnapshot;
		const running: Running = { job, controller, token: randomBytes(32).toString("hex"), runtime };
		try {
			combined.throwIfAborted();
			if (!parent) {
				if (this.roots >= config.maxParallel)
					throw new Error("Top-level delegate concurrency budget is full");
				this.roots++;
				countedRoot = true;
			}
			if (profile.role === "thinker") {
				if (this.thinkers >= config.maxThinkers) throw new Error("Thinker concurrency budget is full");
				this.thinkers++;
				countedThinker = true;
			}
			this.active.set(id, running);
			timer = setTimeout(
				() => controller.abort(new Error("Delegate time budget exhausted")),
				profile.timeoutMs,
			);
			this.save(job);
			if (profile.delivery === "pr" && !config.publication)
				throw new Error(
					"prmanager delivery needs delegates.publication authorization in user settings. Configure it or use a candidate-only profile.",
				);
			const reviewRequest = profile.role === "crmanager" ? parseReview(invocation) : undefined;
			const reviewExtension = reviewRequest
				? config.reviewExtension ?? path.join(this.options.agentDir, "git/github.com/earendil-works/pi-review/review.ts")
				: undefined;
			if (reviewExtension && !fs.statSync(reviewExtension, { throwIfNoEntry: false })?.isFile())
				throw new Error("crmanager needs pi-review. Install it with pi install git:github.com/earendil-works/pi-review or set delegates.reviewExtension to its absolute file path.");
			if (invocation.continue) {
				await validateWorkspace(
					runtime,
					job.workspace,
					job.delivery.commitSha ?? job.workspace.baseSha!,
					config.publication?.remote ?? "origin",
					combined,
				);
			} else if (profile.workspace === "clone") {
				base ??= await resolveBase(runtime, cwd, invocation.base ?? (reviewRequest ? "HEAD" : undefined));
				job.workspace = await createClone(
					runtime,
					reviewRequest ? { ...base, subdir: "" } : base,
					job.logDir,
					id,
					invocation.name,
					reviewRequest ? "origin" : config.publication?.remote ?? "origin",
					combined,
				);
				this.save(job);
				if (reviewRequest && reviewExtension) {
					const prepared = await prepareReview(runtime, reviewRequest, job.workspace, job.logDir, combined);
					if (job.workspace.excludedDirtyChanges) prepared.scope += "; uncommitted caller changes excluded";
					running.review = { ...prepared, extension: reviewExtension };
					this.save(job);
				} else {
					const before = await candidateTree(runtime, job.workspace.path, job.logDir, combined);
					for (const [i, setup] of config.environment.setup.entries()) {
						const r = await runtime.execute({
							executable: "/bin/sh",
							args: ["-c", setup.command],
							cwd: job.workspace.cwd,
							signal: combined,
							timeoutMs: setup.timeoutMs,
							log: path.join(job.logDir, `setup-${i}.log`),
						});
						if (r.code || r.interrupted) throw new Error(`Setup ${setup.name} failed; see job logs`);
					}
					if ((await candidateTree(runtime, job.workspace.path, job.logDir, combined)) !== before)
						throw new Error(
							"Setup changed candidate source files; inspect the retained workspace before continuation",
						);
				}
			}
			if (profile.workspace === "shared" && profile.permissions === "read-write") {
				if (this.reservations.has(job.workspace.path) || this.toolOwners.has(job.workspace.path))
					throw new Error("Workspace already has an active writer");
				this.reservations.set(job.workspace.path, id);
				reserved = true;
			}
			const promptFile = path.join(job.logDir, "prompt.md");
			fs.writeFileSync(promptFile, profilePrompt(profile, config), { mode: 0o600 });
			const bootstrap: Bootstrap = {
				version: 1,
				socket: this.server.socket,
				token: running.token,
				jobId: id,
			};
			const tools = allowedTools(profile, config);
			const args = [
				"--mode",
				"json",
				"--no-session",
				"--no-extensions",
				"--no-mcp",
				"--no-approve",
				"--no-skills",
				"--no-prompt-templates",
				"-e",
				this.options.extensionPath,
				"-e",
				"builtin:codemode",
				"--model",
				profile.model,
				"--tools",
				tools.join(","),
				"--append-system-prompt",
				promptFile,
			];
			for (const e of config.extensions)
				if (!reviewRequest && (profile.permissions === "read-write" || e.readOnly)) args.push("-e", e.path);
			args.push(
				"--",
				reviewRequest ? "/delegates-review" : `Task: ${invocation.task}\n\n${invocation.continue ? `Continue retained candidate ${id}; previous PR: ${job.delivery.prUrl ?? "none"}. Inspect existing changes before editing.` : ""}\n${job.workspace.excludedDirtyChanges ? "The caller explicitly selected a committed base. Uncommitted parent changes were excluded." : ""}`,
			);
			let buffer = "",
				providerError = "",
				aborted = false;
			// Widget activity line, read from the stream the parent already receives. Display only.
			const observe = (event: any) => {
				const runId = job.displayRunId!;
				const callId = String(event.toolCallId);
				// Calls made by a codemode script arrive as their own events, so the newest running call wins.
				if (event.type === "tool_execution_start")
					return this.display.call(runId, callId, summarizeCall(event.toolName, event.args));
				if (event.type === "tool_execution_end") return this.display.call(runId, callId);
				if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_end")
					return this.display.note(runId, lastSentence(event.assistantMessageEvent.content));
				return false;
			};
			const onLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					throw new Error("Child wrote invalid JSONL to stdout");
				}
				try {
					if (observe(event)) this.emitDisplay();
				} catch {
					/* Presentation must not alter execution. */
				}
				if (event.type === "agent_settled" && event.aborted) aborted = true;
				if (event.type !== "message_end" || event.message?.role !== "assistant") return;
				const message = event.message;
				const text = (message.content ?? [])
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n");
				if (text) {
					job.summary = truncate(text, config.maxOutputBytes);
					this.display.note(job.displayRunId!, lastSentence(text));
				}
				providerError = ["error", "aborted"].includes(message.stopReason)
					? message.errorMessage || `Provider ${message.stopReason}`
					: ""; // A later successful turn may be Pi's automatic retry/recovery.
				const u = message.usage ?? {};
				for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
					job.usage[key] += u[key] ?? 0;
				job.usage.cost += u.cost?.total ?? 0;
				job.usage.turns++;
				job.selfUsage = { ...job.usage };
				this.save(job);
			};
			job.execution = "running";
			this.save(job);
			const r = await runtime.execute({
				executable: this.options.piCommand.executable,
				args: [...this.options.piCommand.args, ...args],
				cwd: job.workspace.cwd,
				env: {
					PI_DELEGATE_BOOTSTRAP: JSON.stringify(bootstrap),
					PI_SUBAGENT_ROLE: undefined,
					PI_BRANCH_WORKER: undefined,
				},
				signal: combined,
				timeoutMs: profile.timeoutMs,
				log: path.join(job.logDir, `child-${Date.now()}.log`),
				maxOutputBytes: config.maxOutputBytes,
				onStdout: (chunk) => {
					buffer += chunk;
					let newline: number;
					while ((newline = buffer.indexOf("\n")) >= 0) {
						onLine(buffer.slice(0, newline));
						buffer = buffer.slice(newline + 1);
					}
					if (Buffer.byteLength(buffer) > 8_000_000) throw new Error("Child JSONL record exceeded limit");
				},
			});
			if (buffer.trim()) onLine(buffer);
			if (r.interrupted || combined.aborted || aborted) throw new Error("Delegate cancelled or timed out");
			if (running.reviewError || r.code || providerError)
				throw new Error(running.reviewError || providerError || r.stderr || `Child exited ${r.code}`);
			if (!running.ready)
				throw new Error(
					"Delegate initialization did not complete; inspect child logs for missing tools/provider extensions",
				);
			if (reviewRequest && !job.summary.trim()) throw new Error("The /review command produced no review report; inspect child logs");
			job.execution = "stopped";
			if (profile.delivery !== "none" && !["delivered", "candidate-ready"].includes(job.delivery.status))
				job.error =
					job.delivery.error ??
					"PR manager stopped without completing its delivery contract; workspace retained";
			// A finalized result must still refer to the candidate that actually remains on disk.
			if (["delivered", "candidate-ready"].includes(job.delivery.status)) {
				await validateWorkspace(
					runtime,
					job.workspace,
					job.delivery.commitSha!,
					config.publication?.remote ?? "origin",
					combined,
				);
				if (
					(await candidateTree(runtime, job.workspace.path, job.logDir, combined)) !== job.delivery.treeSha
				) {
					job.delivery.status = "blocked";
					throw new Error("Candidate changed after submission");
				}
			}
		} catch (error) {
			job.execution = combined.aborted ? "cancelled" : "failed";
			job.error = truncate(error instanceof Error ? error.message : String(error), config.maxOutputBytes);
		} finally {
			if (timer) clearTimeout(timer);
			controller.abort(new Error("Owning delegate finished"));
			for (const child of this.active.values())
				if (child.job.parentId === id) child.controller.abort(new Error("Parent finished"));
			await Promise.allSettled([...(this.childRuns.get(id) ?? [])]);
			this.childRuns.delete(id);
			await runtime.shutdown();
			if (profile.role !== "crmanager") {
				const inspection = createRuntime("host");
				try {
					const bounded = AbortSignal.timeout(5_000);
					const tracked = await git(
						inspection,
						job.workspace.path,
						["diff", "--name-only", "-z", job.workspace.baseSha ?? "HEAD", "--"],
						bounded,
					);
					const untracked = await git(
						inspection,
						job.workspace.path,
						["ls-files", "--others", "--exclude-standard", "-z"],
						bounded,
					);
					job.changedFiles = [...new Set((tracked + "\0" + untracked).split("\0").filter(Boolean))];
				} catch {
					/* Non-Git shared workspaces and failed preparation still return their original result. */
				} finally {
					await inspection.shutdown();
				}
			}
			if (reserved && this.reservations.get(job.workspace.path) === id)
				this.reservations.delete(job.workspace.path);
			if (this.toolOwners.get(job.workspace.path)?.jobId === id) this.toolOwners.delete(job.workspace.path);
			if (countedRoot) this.roots--;
			if (countedThinker) this.thinkers--;
			for (const child of this.completed.values())
				if (child.parentId === id && child.startedAt >= job.startedAt)
					for (const key of Object.keys(job.usage) as (keyof typeof job.usage)[])
						job.usage[key] += child.usage[key];
			job.finishedAt = new Date().toISOString();
			this.active.delete(id);
			this.completed.set(id, job);
			this.save(job);
			release?.();
		}
		return resultOf(job);
	}
	cancel(id: string): void {
		const running = this.active.get(id);
		if (!running) throw new Error("Job is not running in this session");
		running.controller.abort(new Error("Cancelled by caller"));
	}
	async shutdown(): Promise<void> {
		this.shutdownRequested = true;
		for (const r of this.active.values()) r.controller.abort(new Error("Session ended/reloaded"));
		await Promise.allSettled([...this.pending]);
		this.listeners.clear();
		if (this.starting) {
			await this.starting;
			await this.server.close();
		}
	}
}
