import type { Config, Invocation, Job, Profile, Role } from "./types.ts";
import { resultOf } from "./types.ts";

export type DisplayMode = "compact" | "detailed";
export type Tone = "active" | "success" | "warning" | "error" | "muted";
export interface DisplayRun {
	id: string;
	runId: string;
	scopeId: string;
	parentRunId?: string;
	name: string;
	profile: string;
	role: Role;
	model: string;
	mode: DisplayMode;
	show: boolean;
	/** False until a manifest exists; a rejected continuation must not hide its live predecessor. */
	persisted?: boolean;
	deliveryMode: Profile["delivery"];
	startedAt: number;
	finishedAt?: number;
	execution: Job["execution"];
	verification: Job["verification"];
	delivery: Job["delivery"];
	error?: string;
	success: boolean;
	selfTurns?: number;
	totalTurns?: number;
	contextSnapshot?: Job["contextSnapshot"];
	tools: string[];
	/** What an active delegate is doing now: its running tool call, else the last thing it wrote. */
	activity?: string;
}
export interface LaunchIdentity {
	id: string;
	runId: string;
	scopeId: string;
	parentRunId?: string;
}
export const RETAIN_MS = 5_000;

/**
 * Presentation-only facts: no sockets, timers, disk writes, or permission decisions. Activity text
 * quotes the delegate's own tool arguments and prose; it is shown locally and never persisted here.
 */
export class DisplayTracker {
	private runs = new Map<string, DisplayRun>();
	private tools = new Map<string, Map<string, string>>();
	private calls = new Map<string, Map<string, string>>();
	private notes = new Map<string, string>();
	private refresh(runId: string): boolean {
		const row = this.runs.get(runId);
		if (!row) return false;
		const next =
			row.finishedAt === undefined
				? ([...(this.calls.get(runId)?.values() ?? [])].at(-1) ?? this.notes.get(runId))
				: undefined;
		if (next === row.activity) return false;
		row.activity = next;
		return true;
	}
	private forget(runId: string): void {
		this.tools.delete(runId);
		this.calls.delete(runId);
		this.notes.delete(runId);
		this.refresh(runId);
	}
	/** Records a running tool call's summary, or its end when text is undefined. Returns whether the row changed. */
	call(runId: string, callId: string, text?: string): boolean {
		if (!this.runs.has(runId)) return false;
		if (!this.calls.has(runId)) this.calls.set(runId, new Map());
		if (text) this.calls.get(runId)!.set(callId, text);
		else this.calls.get(runId)!.delete(callId);
		return this.refresh(runId);
	}
	/** Records the last thing the delegate wrote. Returns whether the row changed. */
	note(runId: string, text: string): boolean {
		if (!this.runs.has(runId) || !text) return false;
		this.notes.set(runId, text);
		return this.refresh(runId);
	}
	start(
		identity: LaunchIdentity,
		invocation: Invocation,
		profile: Profile,
		config: Config,
		now = Date.now(),
	): void {
		this.runs.set(identity.runId, {
			...identity,
			name: invocation.name,
			profile: invocation.profile,
			role: profile.role,
			model: profile.model,
			mode: this.runs.get(identity.parentRunId ?? "")?.mode ?? config.display ?? "compact",
			show: this.runs.get(identity.parentRunId ?? "")?.show ?? config.showStatusWidget,
			deliveryMode: profile.delivery,
			startedAt: now,
			persisted: false,
			execution: "preparing",
			verification: { status: "not-run", checks: [] },
			delivery: { status: "not-requested" },
			success: false,
			selfTurns: 0,
			tools: [],
		});
	}
	update(runId: string, job: Job): void {
		const row = this.runs.get(runId);
		if (!row) return;
		Object.assign(row, {
			persisted: true,
			model: job.profile.model,
			execution: job.execution,
			finishedAt: job.finishedAt ? Date.parse(job.finishedAt) : undefined,
			verification: structuredClone(job.verification),
			delivery: { ...job.delivery },
			error: job.error,
			success: resultOf(job).success,
			selfTurns: job.selfUsage?.turns,
			totalTurns: job.finishedAt ? job.usage.turns : undefined,
			contextSnapshot: job.contextSnapshot,
		});
		if (row.finishedAt !== undefined) {
			row.tools = [];
			this.forget(runId);
		}
	}
	fail(runId: string, error: unknown, cancelled: boolean): void {
		const row = this.runs.get(runId);
		if (!row || row.finishedAt !== undefined) return;
		Object.assign(row, {
			execution: cancelled ? "cancelled" : "failed",
			finishedAt: Date.now(),
			success: false,
			error: String(error),
			tools: [],
		});
		this.forget(runId);
	}
	beginTool(runId: string, callId: string, name: string): void {
		const row = this.runs.get(runId);
		if (!row || row.finishedAt !== undefined) return;
		if (!this.tools.has(runId)) this.tools.set(runId, new Map());
		this.tools.get(runId)!.set(callId, name);
		row.tools = [...this.tools.get(runId)!.values()];
	}
	endTool(runId: string, callId: string): void {
		this.tools.get(runId)?.delete(callId);
		const row = this.runs.get(runId);
		if (row) row.tools = [...(this.tools.get(runId)?.values() ?? [])];
	}
	scopeOf(runId?: string): string | undefined {
		return runId ? this.runs.get(runId)?.scopeId : undefined;
	}
	snapshot(scopeId?: string): DisplayRun[] {
		return [...this.runs.values()]
			.filter((r) => scopeId === undefined || r.scopeId === scopeId)
			.map((r) => structuredClone(r));
	}
}

/** Strip terminal escapes/control characters before any terminal styling. */
export function clean(value: unknown): string {
	return String(value ?? "")
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
		.replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|$)/g, "")
		.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
export const active = (row: Pick<DisplayRun, "execution" | "finishedAt">) =>
	row.finishedAt === undefined && ["preparing", "running"].includes(row.execution);
export function elapsed(row: DisplayRun, now: number): string {
	if (!active(row) && row.finishedAt === undefined) return "";
	const seconds = Math.max(0, Math.floor(((row.finishedAt ?? now) - row.startedAt) / 1000));
	if (!Number.isFinite(seconds)) return "";
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
}
export interface Status {
	label: string;
	tone: Tone;
	symbol: string;
	error?: string;
}
export function status(
	row: Pick<
		DisplayRun,
		"execution" | "finishedAt" | "error" | "delivery" | "verification" | "deliveryMode" | "success" | "tools"
	>,
	children: DisplayRun[] = [],
): Status {
	const rawProblem = row.error || row.delivery.error || row.verification.error;
	const problem = rawProblem ? clean(rawProblem) || "Error (see /delegates inspect)" : "";
	const out = (label: string, tone: Tone, symbol: string, error = problem): Status => ({
		label,
		tone,
		symbol,
		...(error ? { error } : {}),
	});
	if (row.execution === "cancelled") return out("Cancelled", "muted", "–");
	if (row.execution === "interrupted") return out("Interrupted", "muted", "–");
	if (row.execution === "failed") return out("Failed", "error", "✗");
	if (!active(row)) {
		if (
			!row.success ||
			problem ||
			["failed", "blocked", "stale"].includes(row.verification.status) ||
			["blocked", "failed"].includes(row.delivery.status)
		)
			return out(row.delivery.status === "no-changes" ? "No changes" : "Incomplete", "warning", "!");
		return out(
			row.deliveryMode === "pr"
				? "PR delivered"
				: row.deliveryMode === "candidate"
					? "Candidate ready"
					: "Done",
			"success",
			"✓",
		);
	}
	// These are observed workflow stages, not guesses based on a role or Bash command.
	if (row.deliveryMode !== "none") {
		if (row.verification.status === "running") return out("Verifying", "active", "●");
		if (row.delivery.status === "publishing") return out("Publishing", "active", "●");
		if (row.delivery.status === "checks-pending") return out("Waiting for CI", "active", "●");
	}
	if (problem || ["blocked", "failed"].includes(row.delivery.status))
		return out("Needs attention", "warning", "!");
	if (row.verification.status === "failed") return out("Checks failed", "warning", "!");
	if (row.verification.status === "stale") return out("Needs verification", "warning", "!");
	if (row.verification.status === "blocked") return out("Checks blocked", "warning", "!");
	const tools = row.tools.filter(
		(t) => !["codemode", "delegate", "delegate_parallel", "delegate_verify", "delegate_submit"].includes(t),
	);
	if (tools.length) {
		const labels = new Set(
			tools.map((t) =>
				t === "web_search"
					? "Searching"
					: t === "web_fetch"
						? "Fetching sources"
						: ["read", "grep", "find", "ls"].includes(t)
							? "Inspecting"
							: ["edit", "write"].includes(t)
								? "Editing"
								: t === "bash"
									? "Running command"
									: "Running tools",
			),
		);
		return out(labels.size === 1 ? [...labels][0] : "Running tools", "active", "●");
	}
	if (children.some(active)) return out("Coordinating", "active", "●");
	return out(row.execution === "preparing" ? "Preparing" : "Running", "active", "●");
}
export function childProgress(children: DisplayRun[]): string {
	if (!children.length) return "";
	const running = children.filter(active).length;
	const done = children.filter((r) => !active(r) && r.success).length;
	const cancelled = children.filter(
		(r) => r.execution === "cancelled" || r.execution === "interrupted",
	).length;
	const failed = children.length - running - done - cancelled;
	if (failed || cancelled)
		return [
			done && `${done} done`,
			failed && `${failed} failed`,
			cancelled && `${cancelled} cancelled`,
			running && `${running} running`,
		]
			.filter(Boolean)
			.join(", ");
	return `${done}/${children.length} finished`;
}
export interface DisplayRow {
	run: DisplayRun;
	depth: number;
	name: string;
	status: Status;
	progress: string;
	elapsed: string;
	detailed: boolean;
	activity: string;
}
export function visibleRuns(runs: DisplayRun[], now = Date.now()): DisplayRun[] {
	const shown = runs.filter((r) => r.show);
	const byId = new Map(shown.map((r) => [r.runId, r]));
	const latest = new Map(shown.filter((r) => r.persisted !== false).map((r) => [r.id, r.runId]));
	return shown.filter((row) => {
		let root = row;
		const seen = new Set([root.runId]);
		while (root.parentRunId && byId.has(root.parentRunId) && !seen.has(root.parentRunId)) {
			root = byId.get(root.parentRunId)!;
			seen.add(root.runId);
		}
		return (
			(root.persisted === false || latest.get(root.id) === root.runId) &&
			(active(root) || (root.finishedAt !== undefined && now - root.finishedAt < RETAIN_MS))
		);
	});
}
export function buildRows(runs: DisplayRun[], now = Date.now(), mode?: DisplayMode): DisplayRow[] {
	const byId = new Map(runs.map((r) => [r.runId, r]));
	const children = new Map<string, DisplayRun[]>();
	for (const r of runs)
		if (r.parentRunId && byId.has(r.parentRunId)) {
			if (!children.has(r.parentRunId)) children.set(r.parentRunId, []);
			children.get(r.parentRunId)!.push(r);
		}
	const roots = runs.filter((r) => !r.parentRunId || !byId.has(r.parentRunId));
	const output: DisplayRow[] = [],
		visited = new Set<string>();
	const visit = (siblings: DisplayRun[], depth: number) => {
		const counts = new Map<string, number>();
		for (const r of siblings) counts.set(clean(r.name), (counts.get(clean(r.name)) ?? 0) + 1);
		for (const r of siblings) {
			if (visited.has(r.runId)) continue;
			visited.add(r.runId);
			const sub = children.get(r.runId) ?? [];
			output.push({
				run: r,
				depth: Math.min(depth, 3),
				name: clean(r.name) + (counts.get(clean(r.name))! > 1 ? ` [${clean(r.id.slice(0, 8))}]` : ""),
				status: status(r, sub),
				progress: childProgress(sub),
				elapsed: elapsed(r, now),
				detailed: (mode ?? r.mode) === "detailed",
				activity: active(r) ? clean(r.activity) : "",
			});
			visit(sub, depth + 1);
		}
	};
	visit(roots, 0);
	return output;
}
export function metrics(r: DisplayRun): string {
	const turns = r.selfTurns === undefined ? "turns ?" : `${r.selfTurns} turns`;
	const tokens = r.contextSnapshot?.tokens;
	const context = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0
		? `${Math.round(tokens / 1000)}k tok`
		: "ctx ?";
	return `${turns} · ${context}`;
}
export function detail(row: DisplayRow): string {
	const r = row.run;
	const turns =
		r.selfTurns === undefined
			? `${r.totalTurns ?? 0} recorded turns`
			: `${r.selfTurns} turns${r.totalTurns !== undefined ? ` · tree: ${r.totalTurns} turns` : ""}`;
	return clean(`${r.persisted === false ? "launch" : "id"}: ${clean(r.id)} · ${clean(r.model)} · ${turns} · ${metrics(r).split(" · ").slice(1).join(" · ")}`);
}
export function plainRows(runs: DisplayRun[], now = Date.now(), mode: DisplayMode = "compact"): string {
	return buildRows(runs, now, mode)
		.flatMap((row) => {
			const prefix = "  ".repeat(row.depth);
			const main = `${prefix}${row.status.symbol} [${clean(row.run.profile)}] · ${row.status.label} · ${metrics(row.run)}${row.progress ? ` · ${row.progress}` : ""}${row.elapsed ? ` · ${row.elapsed}` : ""} · ${row.name}${row.activity ? ` · ${row.activity}` : ""}`;
			return [
				main,
				...(row.status.error
					? [
							`${prefix}  ${row.status.error} · ${row.run.persisted === false ? "launch" : "id"}: ${clean(row.run.id)}`,
						]
					: []),
				...(row.detailed ? [`${prefix}  ${detail(row)}`] : []),
			];
		})
		.join("\n");
}
/** Backward-compatible history view; do not invent self usage for old aggregated manifests. */
export function historicalRuns(jobs: Job[]): DisplayRun[] {
	const rows = jobs.map((job) => ({
		id: job.id,
		runId: job.displayRunId ?? job.id,
		scopeId: "history",
		parentRunId: job.displayParentRunId ?? job.parentId,
		name: job.invocation.name,
		profile: job.profileName,
		role: job.profile.role,
		model: job.profile.model,
		mode: job.config.display ?? "compact",
		show: true,
		deliveryMode: job.profile.delivery,
		startedAt: Date.parse(job.startedAt),
		finishedAt: job.finishedAt ? Date.parse(job.finishedAt) : undefined,
		execution: job.execution,
		verification: job.verification,
		delivery: job.delivery,
		error: job.error,
		success: resultOf(job).success,
		selfTurns: job.selfUsage?.turns,
		totalTurns: job.usage.turns,
		contextSnapshot: job.contextSnapshot,
		tools: [],
	}));
	return rows.sort((a, b) => a.startedAt - b.startedAt);
}
