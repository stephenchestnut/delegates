import {
	active,
	buildRows,
	clean,
	detail,
	metrics,
	type DisplayMode,
	type DisplayRow,
	type DisplayRun,
	type Tone,
} from "./display.ts";
import type { Role } from "./types.ts";

/** Production supplies Pi's terminal-column helpers; no hand-written wcwidth implementation. */
export interface RenderStyle {
	width(text: string): number;
	truncate(text: string, width: number): string;
	status(text: string, tone: Tone): string;
	profile(text: string, role: Role): string;
	muted(text: string): string;
}
export interface RenderOptions {
	maxLines?: number;
	heading?: boolean;
	ascii?: boolean;
	mode?: DisplayMode;
	now?: number;
}
function rowCost(row: DisplayRow): number {
	return 1 + (row.detailed || row.status.error ? 1 : 0);
}
function symbol(row: DisplayRow, ascii: boolean): string {
	if (!ascii) return row.status.symbol;
	return (
		({ "●": "*", "✓": "+", "✗": "x", "–": "-" } as Record<string, string>)[row.status.symbol] ??
		row.status.symbol
	);
}
function renderRow(row: DisplayRow, width: number, style: RenderStyle, ascii: boolean): string[] {
	const indent = " ".repeat(Math.min(row.depth * 2, Math.max(0, width - 12)));
	const prefix = `${indent}${style.status(symbol(row, ascii), row.status.tone)} `;
	const available = Math.max(0, width - style.width(prefix));
	let profile = `[${clean(row.run.profile)}]`,
		progress = row.progress,
		duration = row.elapsed,
		stats = metrics(row.run);
	const tail = () => [profile, row.status.label, stats, progress, duration].filter(Boolean).join(" · ");
	// Preserve a name and explicit status first; secondary fields yield to narrow terminals.
	for (const drop of [
		() => {
			progress = "";
		},
		() => {
			duration = "";
		},
		() => {
			profile = "";
		},
		() => {
			stats = "";
		},
	]) {
		if (style.width(tail()) + Math.min(20, style.width(row.name)) + 3 <= available) break;
		drop();
	}
	const statusBudget = Math.max(1, available - 8);
	const label = style.truncate(row.status.label, statusBudget);
	const tokens = [
		profile ? style.profile(profile, row.run.role) : "",
		style.status(label, row.status.tone),
		stats ? style.muted(stats) : "",
		progress ? style.muted(progress) : "",
		duration ? style.muted(duration) : "",
	].filter(Boolean);
	const suffix = tokens.join(style.muted(" · "));
	const nameWidth = Math.max(0, available - style.width(suffix) - 3);
	const name = style.truncate(row.name, nameWidth);
	const lines = [style.truncate(prefix + suffix + (name ? style.muted(" · ") + name : ""), width)];
	if (row.status.error) {
		// Keep a reference visible even if the diagnostic itself must be shortened.
		const ref = ` [${row.run.persisted === false ? "launch:" : ""}${clean(row.run.id.slice(0, 8))}]`;
		const budget = Math.max(0, width - style.width(indent + "  " + ref));
		lines.push(
			style.truncate(
				indent +
					"  " +
					style.status(style.truncate(row.status.error, budget), row.status.tone) +
					style.muted(ref),
				width,
			),
		);
	} else if (row.detailed) {
		lines.push(style.truncate(indent + "  " + style.muted(detail(row)), width));
	}
	return lines;
}
export function renderDisplay(
	runs: DisplayRun[],
	width: number,
	style: RenderStyle,
	options: RenderOptions = {},
): string[] {
	if (width <= 0 || !runs.length) return [];
	const max = Math.max(1, options.maxLines ?? 8);
	const heading = options.heading !== false && max > 1;
	const rows = buildRows(runs, options.now ?? Date.now(), options.mode);
	const available = max - (heading ? 1 : 0);
	const allFit = rows.reduce((sum, r) => sum + rowCost(r), 0) <= available;
	const capacity = available - (allFit ? 0 : 1);
	const selected = new Set<string>();
	const byRun = new Map(rows.map((r) => [r.run.runId, r]));
	let used = 0;
	const priority = (r: DisplayRow) =>
		["error", "warning"].includes(r.status.tone) ? 0 : active(r.run) ? 1 : 2;
	for (const row of [...rows].sort((a, b) => priority(a) - priority(b))) {
		const chain: DisplayRow[] = [];
		let cursor: DisplayRow | undefined = row;
		while (cursor && !selected.has(cursor.run.runId) && !chain.includes(cursor)) {
			chain.unshift(cursor);
			cursor = cursor.run.parentRunId ? byRun.get(cursor.run.parentRunId) : undefined;
		}
		const cost = chain.reduce((n, r) => n + rowCost(r), 0);
		if (used + cost > capacity) continue;
		for (const r of chain) selected.add(r.run.runId);
		used += cost;
	}
	const lines = heading ? [style.muted("Delegates")] : [];
	for (const row of rows)
		if (selected.has(row.run.runId)) lines.push(...renderRow(row, width, style, options.ascii ?? false));
	const omitted = rows.length - selected.size;
	if (omitted)
		lines.push(
			style.muted(style.truncate(`${options.ascii ? "..." : "…"} ${omitted} more · /delegates list`, width)),
		);
	return lines
		.slice(0, max)
		.map((line) => style.truncate(options.ascii ? line.replace(/ · /g, " | ") : line, width));
}
