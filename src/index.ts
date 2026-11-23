import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, migrateSettings, readSettings, resolveConfig } from "./config.ts";
import { Coordinator } from "./runner.ts";
import { reviewPrompt } from "./review-bridge.ts";
import { request } from "./control.ts";
import { PARENT_GUIDANCE } from "./profiles.ts";
import { resultOf } from "./types.ts";
import type { Bootstrap, ChildContext, Usage, Role } from "./types.ts";
import { createRuntime } from "./runtime/host.ts";
import { repoRoot } from "./delivery/git.ts";
import { clean, historicalRuns, plainRows, status, type DisplayRun } from "./display.ts";
import { Viewer } from "./viewer.ts";
import { DelegateWidget, resultComponent, renderStyle } from "./ui.ts";
import { renderDisplay } from "./display-render.ts";

const namespace = {
	name: "delegates",
	description: "Profile-based research, code review, coding, and verified PR delegation",
	instructions:
		PARENT_GUIDANCE +
		" Await calls. Inspect success and execution/verification/delivery status. Use delegate_parallel for one pinned-base batch. Tools are callable through codemode; children can use their own codemode with restricted tools.",
};
const JobResultSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	profile: Type.String(),
	model: Type.String(),
	execution: Type.String(),
	success: Type.Boolean(),
	summary: Type.String(),
	error: Type.Optional(Type.String()),
	workspace: Type.Object({
		kind: Type.String(),
		path: Type.String(),
		cwd: Type.String(),
		source: Type.String(),
		baseSha: Type.Optional(Type.String()),
		branch: Type.Optional(Type.String()),
		remoteUrl: Type.Optional(Type.String()),
		excludedDirtyChanges: Type.Optional(Type.Boolean()),
	}),
	verification: Type.Object({
		status: Type.String(),
		fingerprint: Type.Optional(Type.String()),
		policyHash: Type.Optional(Type.String()),
		error: Type.Optional(Type.String()),
		checks: Type.Array(Type.Object({ name: Type.String(), code: Type.Number(), log: Type.String() })),
	}),
	delivery: Type.Object({
		status: Type.String(),
		commitSha: Type.Optional(Type.String()),
		treeSha: Type.Optional(Type.String()),
		pushedSha: Type.Optional(Type.String()),
		prUrl: Type.Optional(Type.String()),
		error: Type.Optional(Type.String()),
	}),
	usage: Type.Object({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		cost: Type.Number(),
		turns: Type.Number(),
	}),
	logDir: Type.String(),
	changedFiles: Type.Optional(Type.Array(Type.String())),
});
function invocationSchema(profiles: string[], child: boolean) {
	return Type.Object(
		{
			profile: Type.Union(profiles.map((p) => Type.Literal(p))),
			name: Type.String({ minLength: 1, maxLength: 60 }),
			task: Type.String({ minLength: 1 }),
			model: Type.Optional(Type.String()),
			...(!child ? { base: Type.Optional(Type.String()), continue: Type.Optional(Type.String()) } : {}),
		},
		{ additionalProperties: false },
	);
}
function toolResult(value: any, usage?: Usage) {
	const data = JSON.parse(JSON.stringify(value));
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		details: data,
		structuredContent: data,
		...(usage
			? {
					usage: {
						input: usage.input,
						output: usage.output,
						cacheRead: usage.cacheRead,
						cacheWrite: usage.cacheWrite,
						totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
					},
				}
			: {}),
	};
}
function invocationCommand(): { executable: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script))
		return { executable: process.execPath, args: [script] };
	return /^(node|bun)(\.exe)?$/.test(path.basename(process.execPath))
		? { executable: "pi", args: [] }
		: { executable: process.execPath, args: [] };
}
function resolveModel(ref: string, pi: ExtensionAPI, ctx: ExtensionContext): string {
	if (ref === "inherit") {
		if (!ctx.model) throw new Error("No caller model to inherit");
		return `${ctx.model.provider}/${ctx.model.id}:${pi.getThinkingLevel()}`;
	}
	const plain = ref.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
	if (!ctx.modelRegistry.getAll().some((m) => `${m.provider}/${m.id}` === plain))
		throw new Error(
			`Unknown model '${ref}'. Use an exact provider/model ID (optional :thinking suffix), or inherit.`,
		);
	return ref;
}
export default function delegates(pi: ExtensionAPI) {
	const bootstrap: Bootstrap | undefined = process.env.PI_DELEGATE_BOOTSTRAP
		? JSON.parse(process.env.PI_DELEGATE_BOOTSTRAP)
		: undefined;
	let coordinator: Coordinator | undefined,
		child: ChildContext | undefined,
		parentWorkspace: string | undefined;
	let currentContext: ExtensionContext | undefined;
	let widget: DelegateWidget | undefined;
	let viewer: Viewer | undefined;
	let closing = false;
	const profileRoles = new Map<string, Role>();
	const renderDelegateResult = (
		result: any,
		options: { expanded: boolean; isPartial: boolean },
		theme: Parameters<typeof renderStyle>[0],
	) => {
		const live = result.details?.delegateDisplay as DisplayRun[] | undefined;
		if (options.isPartial && live)
			return {
				render: (width: number) =>
					renderDisplay(live, width, renderStyle(theme), {
						heading: false,
						ascii: process.env.TERM === "dumb",
					}),
				invalidate() {},
			};
		const fallback =
			result.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") ?? "";
		const runs = coordinator?.displaySnapshot() ?? [];
		return resultComponent(
			result.structuredContent ?? result.details?.delegateResult ?? result.details,
			fallback,
			options.expanded,
			theme,
			(r) =>
				runs.find((run) => run.id === r.id)?.role ??
				child?.config.profiles[r.profile]?.role ??
				profileRoles.get(r.profile),
			result.details?.delegateDisplay,
		);
	};
	const agentDir = getAgentDir();
	const config = (ctx: ExtensionContext) => {
		const resolved = loadConfig(agentDir, ctx.cwd, ctx.isProjectTrusted());
		profileRoles.clear();
		for (const [name, profile] of Object.entries(resolved.profiles)) profileRoles.set(name, profile.role);
		return resolved;
	};
	const getCoordinator = (ctx: ExtensionContext) => {
		currentContext = ctx;
		return (coordinator ??= new Coordinator({
			agentDir,
			extensionPath: fileURLToPath(import.meta.url),
			sessionId: ctx.sessionManager.getSessionId(),
			piCommand: invocationCommand(),
			resolveModel: (ref) => resolveModel(ref, pi, currentContext!),
			onChange: (jobs) => {
				if (closing || currentContext?.mode !== "tui") return;
				const context = currentContext;
				widget ??= new DelegateWidget(context, undefined, {
					select: (run) => {
						void view(currentContext ?? context, run.id).catch((error) =>
							(currentContext ?? context).ui.notify(error instanceof Error ? error.message : String(error), "error"),
						);
					},
					close: () => viewer?.dispose(),
					viewing: () => viewer?.viewing(),
				});
				widget.update(jobs);
			},
		}));
	};
	/** Opens or retargets the session's in-TUI transcript overlay. */
	const view = async (ctx: ExtensionContext, id: string) => {
		if (closing || ctx.mode !== "tui") return;
		const c = getCoordinator(ctx);
		const dir = c.store.dir(id);
		if (!fs.existsSync(dir)) throw new Error(`No recorded delegate job ${id}`);
		const run = c.displaySnapshot().findLast((r) => r.id === id);
		let name = run?.name,
			profile = run?.profile;
		if (!run) {
			const job = c.store.get(id);
			name = job.invocation.name;
			profile = job.profileName;
		}
		viewer ??= new Viewer();
		viewer.show(ctx, { id, dir, name: name ?? id, profile: profile ?? "delegate" });
	};
	/** Full ID, a unique ID prefix, or a picker of this session's delegates (else recent history). */
	const chooseJob = async (ctx: ExtensionContext, ref?: string): Promise<string | undefined> => {
		const c = getCoordinator(ctx);
		if (ref && /^[a-f0-9-]{36}$/.test(ref)) return ref;
		if (ref) {
			const matches = c.store.list().filter((j) => j.id.startsWith(ref));
			if (matches.length === 1) return matches[0].id;
			throw new Error(matches.length ? `'${ref}' matches ${matches.length} jobs; use more of the ID` : `No delegate job matches '${ref}'`);
		}
		const seen = new Set<string>();
		let runs = c
			.displaySnapshot()
			.filter((r) => r.persisted !== false)
			.reverse()
			.filter((r) => !seen.has(r.id) && seen.add(r.id));
		if (!runs.length) runs = historicalRuns(c.store.list().slice(0, 15)).reverse();
		if (!runs.length) throw new Error("No delegate jobs recorded.");
		const labels = new Map(
			runs.map((r) => [`${clean(r.name)} · [${clean(r.profile)}] · ${status(r).label} · ${r.id.slice(0, 8)}`, r.id]),
		);
		const chosen = await ctx.ui.select("View delegate transcript", [...labels.keys()]);
		return chosen ? labels.get(chosen) : undefined;
	};
	const registerLaunchTools = (profiles: string[], isChild: boolean) => {
		if (!profiles.length) return;
		const params = invocationSchema(profiles, isChild);
		pi.registerTool({
			name: "delegate",
			label: "Delegate",
			namespace,
			exposure: "direct",
			parameters: params,
			outputSchema: JobResultSchema,
			renderResult: renderDelegateResult,
			description:
				"Run a named delegate with a configured profile. Returns structured execution, verification, delivery, workspace and usage results. Attached: await completion.",
			promptSnippet: "Delegate focused research, code review, coding, or verified PR work using named profiles",
			promptGuidelines: [
				isChild
					? `Only delegate to ${profiles.join(", ")}; obey shared-workspace ownership.`
					: PARENT_GUIDANCE,
			],
			async execute(_id, args, signal, onUpdate, ctx) {
				onUpdate?.({
					content: [{ type: "text", text: `Starting ${args.profile}: ${args.name}` }],
					details: undefined,
				});
				const c = bootstrap ? undefined : getCoordinator(ctx);
				const scopeId = randomUUID();
				let previous = "";
				const unsubscribe = c?.subscribe((jobs) => {
					const text = plainRows(jobs, Date.now(), jobs[0]?.mode ?? "compact");
					if (text && text !== previous) {
						previous = text;
						onUpdate?.({ content: [{ type: "text", text }], details: { delegateDisplay: jobs } });
					}
				}, scopeId);
				try {
					const result = bootstrap
						? await request<any>(bootstrap, "delegate", args, signal)
						: await c!.run(args, ctx.cwd, config(ctx), signal, undefined, undefined, scopeId);
					const output = toolResult(result, result.usage);
					output.details = { delegateResult: output.details, delegateDisplay: c?.displaySnapshot(scopeId) ?? [] };
					return output;
				} finally {
					unsubscribe?.();
				}
			},
		});
		pi.registerTool({
			name: "delegate_parallel",
			label: "Parallel delegates",
			namespace,
			exposure: "direct",
			parameters: Type.Object(
				{ tasks: Type.Array(params, { minItems: 1, maxItems: 32 }) },
				{ additionalProperties: false },
			),
			outputSchema: Type.Array(JobResultSchema),
			renderResult: renderDelegateResult,
			description:
				"Run a bounded batch of named delegates, preserving result order and independent failures. Clones share one pinned base. Shared coding workers cannot run concurrently.",
			promptSnippet: "Run independent research or isolated prmanager implementations in parallel",
			async execute(_id, args, signal, onUpdate, ctx) {
				const c = bootstrap ? undefined : getCoordinator(ctx);
				const scopeId = randomUUID();
				let previous = "";
				const unsubscribe = c?.subscribe((jobs) => {
					const text = plainRows(jobs, Date.now(), jobs[0]?.mode ?? "compact");
					if (text && text !== previous) {
						previous = text;
						onUpdate?.({ content: [{ type: "text", text }], details: { delegateDisplay: jobs } });
					}
				}, scopeId);
				try {
					const results = bootstrap
						? await request<any[]>(bootstrap, "parallel", args.tasks, signal)
						: await c!.parallel(args.tasks, ctx.cwd, config(ctx), signal, undefined, scopeId);
					const usage = results.reduce(
						(sum, r) => {
							for (const k of Object.keys(sum)) sum[k] += r.usage?.[k] ?? 0;
							return sum;
						},
						{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					);
					const output = toolResult(results, usage);
					output.details = { delegateResult: output.details, delegateDisplay: c?.displaySnapshot(scopeId) ?? [] };
					return output;
				} finally {
					unsubscribe?.();
				}
			},
		});
	};
	const registerReview = (review: NonNullable<ChildContext["review"]>) => {
		pi.registerTool({
			name: "delegate_review_diff",
			label: "Inspect review diff",
			namespace,
			description: "Read the file list or patch for the pinned review scope. For uncommitted reviews, use files to list untracked files, then read their contents directly. If the patch is truncated, narrow it to one file.",
			parameters: Type.Object({
				view: Type.Union([Type.Literal("files"), Type.Literal("patch"), Type.Literal("staged"), Type.Literal("unstaged")]),
				file: Type.Optional(Type.String()),
			}, { additionalProperties: false }),
			async execute(_id, args, signal) {
				return toolResult(await request(bootstrap!, "reviewDiff", args, signal));
			},
		});
		pi.on("input", async (event, ctx) => {
			if (event.text !== "/delegates-review") return;
			try {
				return { action: "transform", text: await reviewPrompt(pi, ctx, agentDir, review) };
			} catch (error) {
				await request(bootstrap!, "reviewError", { error: error instanceof Error ? error.message : String(error) });
				return { action: "handled" };
			}
		});
	};
	const registerDelivery = () => {
		pi.registerTool({
			name: "delegate_verify",
			label: "Verify candidate",
			namespace,
			parameters: Type.Object({}, { additionalProperties: false }),
			outputSchema: JobResultSchema.properties.verification,
			description:
				"Run the job's frozen required verification policy on the current candidate. Source changes invalidate the result. Only prmanagers may call this.",
			async execute(_id, args, signal) {
				return toolResult(await request(bootstrap!, "verify", args, signal));
			},
		});
		pi.registerTool({
			name: "delegate_submit",
			label: "Submit candidate",
			namespace,
			parameters: Type.Object(
				{ summary: Type.String(), acceptanceNotes: Type.String(), limitations: Type.Array(Type.String()) },
				{ additionalProperties: false },
			),
			outputSchema: JobResultSchema.properties.delivery,
			description:
				"Explicitly finalize a verified candidate and, when authorized by the profile, push its assigned branch and create/update its PR. Required CI is checked for the exact commit. Inspect status; blocked is not delivered.",
			async execute(_id, args, signal) {
				return toolResult(await request(bootstrap!, "submit", args, signal));
			},
		});
	};
	if (!bootstrap) {
		// Full profile registration is refreshed on startup, before the first model request.
		registerLaunchTools(
			Object.keys(resolveConfig(readSettings(path.join(agentDir, "settings.json"))).profiles),
			false,
		);
		pi.registerShortcut("ctrl+alt+d", {
			description: "Focus or unfocus the delegate transcript overlay",
			handler: async (ctx) => {
				if (!viewer?.toggleFocus()) ctx.ui.notify("Open a transcript with /delegates tail", "info");
			},
		});
		pi.registerCommand("delegates", {
			description: "Delegates: config | models | list | tail [id|focus|close] | inspect/cancel/recover/discard <id> | migrate",
			handler: async (args, ctx) => {
				try {
					const words = args.trim().split(/\s+/).filter(Boolean);
					const [action = "list", id] = words;
					if (action === "tail") {
						if (ctx.mode !== "tui") throw new Error("The delegate transcript overlay requires the interactive TUI");
						if (words.length > 2 || id?.startsWith("-")) throw new Error("Usage: /delegates tail [id|focus|close]");
						if (id === "close") return viewer?.dispose();
						if (id === "focus") {
							if (!viewer?.toggleFocus()) ctx.ui.notify("Open a transcript with /delegates tail", "info");
							return;
						}
						const job = await chooseJob(ctx, id);
						if (job) await view(ctx, job);
						return;
					}
					const c = getCoordinator(ctx);
					const show = (text: string) => {
						pi.sendMessage({ customType: "delegates", content: text, display: true }, { triggerTurn: false });
					};
					if (action === "config") return show(JSON.stringify(config(ctx), null, 2));
					if (action === "list")
						return show(
							plainRows(historicalRuns(c.store.list()), Date.now(), "detailed") ||
								"No delegate jobs recorded.",
						);
					if (action === "inspect" && id) return show(JSON.stringify(resultOf(c.store.get(id)), null, 2));
					if (action === "cancel" && id) {
						c.cancel(id);
						return show(`Cancellation requested for ${id}; existing publication is not rolled back.`);
					}
					if (action === "recover" && id) return show(JSON.stringify(resultOf(c.store.recover(id)), null, 2));
					if (action === "discard" && id) {
						if (
							!ctx.hasUI ||
							!(await ctx.ui.confirm(
								"Discard delegate workspace?",
								`${id}: delete local workspace only, not remote branch/PR. Logs remain.`,
							))
						)
							return;
						c.store.discard(id);
						return show(`Discarded workspace ${id}`);
					}
					if (action === "migrate") {
						if (
							!ctx.hasUI ||
							!(await ctx.ui.confirm(
								"Migrate legacy settings?",
								"Back up settings, migrate subagents preferences and rename manager profiles to prmanager; publication needs separate authorization.",
							))
						)
							return;
						return show(migrateSettings(path.join(agentDir, "settings.json")));
					}
					if (action === "models") {
						if (!ctx.hasUI)
							throw new Error("Model picker requires UI; edit delegates.profiles in settings instead");
						const chosen = await ctx.ui.select("Delegate profile", Object.keys(config(ctx).profiles));
						if (!chosen) return;
						const models = await ctx.modelRegistry.getAvailable();
						const selected = await ctx.ui.select("Model (thinking suffix may be edited in settings)", [
							"inherit",
							...models.map((m) => `${m.provider}/${m.id}`),
						]);
						if (!selected) return;
						const file = path.join(agentDir, "settings.json"),
							settings = readSettings(file);
						settings.delegates ??= { version: 1 };
						settings.delegates.profiles ??= {};
						settings.delegates.profiles[chosen] ??= {};
						settings.delegates.profiles[chosen].model = selected;
						resolveConfig(settings);
						fs.copyFileSync(file, `${file}.delegates-backup-${Date.now()}`);
						const temp = `${file}.delegates.tmp`;
						fs.writeFileSync(temp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
						fs.renameSync(temp, file);
						return show(`Saved ${chosen} model: ${selected}`);
					}
					show(
						'Usage: /delegates config | models | list | tail [id|focus|close] | inspect/cancel/recover/discard <id> | migrate\nContinue with delegate({profile, name, task, continue: "job-id"}).',
					);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});
	}
	pi.on("session_start", async (_event, ctx) => {
		closing = false;
		currentContext = ctx;
		if (bootstrap) {
			if (bootstrap.version !== 1) throw new Error("Unsupported delegates child protocol");
			child = await request<ChildContext>(bootstrap, "context");
			registerLaunchTools(child.allowedProfiles, true);
			if (child.profile.role === "prmanager") registerDelivery();
			if (child.profile.role === "crmanager" && child.review) registerReview(child.review);
			const registered = new Set(pi.getAllTools().map((t) => t.name));
			const missing = child.allowedTools.filter((t) => !registered.has(t));
			if (missing.length) throw new Error(`Configured child tools failed to load: ${missing.join(", ")}`);
			pi.setActiveTools(child.allowedTools);
			await request(bootstrap, "ready");
		} else {
			registerLaunchTools(Object.keys(config(ctx).profiles), false);
			const runtime = createRuntime("host");
			try {
				parentWorkspace = await repoRoot(runtime, ctx.cwd);
			} catch {
				parentWorkspace = fs.realpathSync(ctx.cwd);
			} finally {
				await runtime.shutdown();
			}
		}
	});
	// Control-channel telemetry is best effort, bounded, and never transmits message content. (The
	// widget's activity line is derived by the parent from the child's own output stream instead.)
	const reportContext = async (ctx: import("@earendil-works/pi-coding-agent").ExtensionContext) => {
		if (!bootstrap) return;
		try {
			const usage = ctx.getContextUsage();
			await request(bootstrap, "contextUsage", {
				tokens: usage?.tokens ?? null,
				contextWindow: usage?.contextWindow ?? null,
			}, AbortSignal.timeout(250));
		} catch { /* Telemetry must not affect delegate execution. */ }
	};
	pi.on("turn_start", async (_event, ctx) => { await reportContext(ctx); });
	pi.on("turn_end", async (_event, ctx) => { await reportContext(ctx); });
	pi.on("session_compact", async (_event, ctx) => { await reportContext(ctx); });
	pi.on("tool_call", async (event, ctx) => {
		if (bootstrap) {
			if (!child || !child.allowedTools.includes(event.toolName))
				return {
					block: true,
					reason: "Tool is not allowed by this delegate profile (including nested codemode calls)",
				};
			try {
				await request(bootstrap, "beginTool", { tool: event.toolName, id: event.toolCallId });
			} catch (error) {
				return { block: true, reason: error instanceof Error ? error.message : String(error) };
			}
		} else if (parentWorkspace && ["bash", "edit", "write", "powershell"].includes(event.toolName)) {
			try {
				getCoordinator(ctx).beginMutation(parentWorkspace, "parent", event.toolCallId);
			} catch (error) {
				return { block: true, reason: error instanceof Error ? error.message : String(error) };
			}
		}
	});
	pi.on("tool_execution_end", async (event) => {
		if (bootstrap && child) await request(bootstrap, "endTool", { id: event.toolCallId }).catch(() => {});
		else if (coordinator && parentWorkspace)
			coordinator.endMutation(parentWorkspace, "parent", event.toolCallId);
	});
	pi.on("session_shutdown", async () => {
		closing = true;
		widget?.dispose();
		widget = undefined;
		viewer?.dispose();
		viewer = undefined;
		await coordinator?.shutdown();
		coordinator = undefined;
		currentContext = undefined;
	});
}
