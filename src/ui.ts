import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	rgbColor,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { DisplayClock, type Clock } from "./display-clock.ts";
import { clean, type DisplayRun } from "./display.ts";
import { renderDisplay, type RenderStyle } from "./display-render.ts";
import type { DelegateResult, Role } from "./types.ts";

const ROLE_RGB: Record<"dark" | "light", Record<Role, [number, number, number]>> = {
	dark: {
		thinker: [105, 177, 255],
		thinktank: [198, 154, 255],
		worker: [235, 203, 99],
		prmanager: [255, 173, 103],
		crmanager: [95, 211, 177],
	},
	light: {
		thinker: [20, 83, 153], thinktank: [112, 46, 153], worker: [111, 83, 0],
		prmanager: [154, 62, 0], crmanager: [0, 111, 91],
	},
};
const STATUS_TOKEN = {
	active: "accent",
	success: "success",
	warning: "warning",
	error: "error",
	muted: "muted",
} as const;
export function renderStyle(
	theme: Theme,
	noColor = process.env.NO_COLOR !== undefined || process.env.TERM === "dumb",
): RenderStyle {
	return {
		width: visibleWidth,
		truncate: (text, width) => {
			const result = truncateToWidth(text, Math.max(0, width), process.env.TERM === "dumb" ? "..." : "…");
			return noColor ? stripVTControlCharacters(result) : result;
		},
		status: (text, tone) => (noColor ? text : theme.fg(STATUS_TOKEN[tone], text)),
		profile: (text, role) => {
			if (noColor) return text;
			const channels = ROLE_RGB[theme.appearance][role];
			return channels ? theme.style(text, { fg: rgbColor(...channels) }) : theme.fg("muted", text);
		},
		muted: (text) => (noColor ? text : theme.fg("muted", text)),
	};
}
/** One widget instance per visible lifecycle; theme is read fresh at render time. */
export class DelegateWidget {
	private clock: DisplayClock;
	private context: ExtensionContext;
	private redraw: () => void = () => {};
	constructor(context: ExtensionContext, clock?: Clock) {
		this.context = context;
		this.clock = new DisplayClock(
			{
				mount: () =>
					context.ui.setWidget("delegates", (tui) => {
						this.redraw = () => tui.requestRender();
						return {
							render: (width) =>
								renderDisplay(this.clock.visible(), width, renderStyle(this.context.ui.theme), {
									ascii: process.env.TERM === "dumb",
									now: this.clock.now(),
								}),
							invalidate() {}, // No cached ANSI strings; resizing/theme changes re-render from facts.
							dispose: () => {
								this.redraw = () => {};
								this.clock.detach();
							},
						};
					}),
				clear: () => context.ui.setWidget("delegates", undefined),
				render: () => this.redraw(),
			},
			clock,
		);
	}
	update(runs: DisplayRun[]): void {
		this.clock.update(runs);
	}
	dispose(): void {
		this.clock.dispose();
		this.redraw = () => {};
	}
}
/** Compact transcript summary; expansion keeps complete result evidence and JSON schemas untouched. */
export function resultComponent(
	data: unknown,
	fallback: string,
	expanded: boolean,
	theme: Theme,
	roleFor?: (result: DelegateResult) => Role | undefined,
	snapshots: DisplayRun[] = [],
): Component {
	const results = Array.isArray(data) ? data : [data];
	const valid =
		results.length > 0 &&
		results.every(
			(r: any) => r && typeof r.success === "boolean" && typeof r.profile === "string" && r.delivery,
		);
	return {
		render(width) {
			const style = renderStyle(theme);
			if (!valid || expanded) {
				const text = expanded && valid ? JSON.stringify(data, null, 2) : fallback;
				return width > 0
					? text
							.split("\n")
							.flatMap((line) => wrapTextWithAnsi((line.match(/^ */)?.[0] ?? "") + clean(line), width))
							.map((line) => style.truncate(line, width))
					: [];
			}
			const rows: DisplayRun[] = (results as DelegateResult[]).map((r, i) => ({
				...(() => {
					const snapshot = snapshots.findLast((run) => run.id === r.id);
					return snapshot ? { selfTurns: snapshot.selfTurns, contextSnapshot: snapshot.contextSnapshot } : {};
				})(),
				id: r.id,
				runId: `${r.id}-${i}`,
				scopeId: "result",
				name: r.name,
				profile: r.profile,
				role: roleFor?.(r) ?? (r.profile as Role),
				model: r.model,
				mode: "compact",
				show: true,
				persisted: !!r.logDir,
				deliveryMode:
					r.delivery.status === "delivered"
						? "pr"
						: r.delivery.status === "candidate-ready"
							? "candidate"
							: "none",
				startedAt: Number.NaN,
				finishedAt: 0,
				execution: r.execution,
				verification: r.verification ?? { status: "not-run", checks: [] },
				delivery: r.delivery,
				error: r.error,
				success: r.success,
				tools: [],
			}));
			return renderDisplay(rows, width, style, { heading: false, ascii: process.env.TERM === "dumb" });
		},
		invalidate() {},
	};
}
