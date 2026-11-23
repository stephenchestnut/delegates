import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
	type Component, type OverlayHandle, type TUI, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { clean } from "./display.ts";
import { TailReader } from "./tail-reader.mjs";

export interface ViewTarget {
	id: string;
	dir: string;
	name: string;
	profile: string;
}

const MAX_LINES = 1_000;
const MAX_LINE_CHARS = 2_000;
const POLL_MS = 200;

/** One passive overlay per session. The same component stays mounted when switching jobs. */
export class Viewer {
	private panel?: TranscriptPanel;
	private handle?: OverlayHandle;
	private close?: () => void;

	viewing(): string | undefined {
		return this.panel?.id;
	}

	show(ctx: ExtensionContext, target: ViewTarget): void {
		if (ctx.mode !== "tui") throw new Error("The delegate transcript overlay requires the interactive TUI");
		if (this.panel) {
			this.panel.select(target);
			this.handle?.unfocus();
			return;
		}
		let mounted: TranscriptPanel | undefined;
		void ctx.ui.custom<void>((tui, theme, _keys, done) => {
			this.close = () => done();
			mounted = new TranscriptPanel(tui, theme, () => this.dispose(), () => this.handle?.unfocus(), () => {
				if (this.panel !== mounted) return;
				this.panel = this.handle = this.close = undefined;
			});
			this.panel = mounted;
			mounted.select(target);
			return mounted;
		}, {
			overlay: true,
			overlayOptions: { anchor: "top-right", width: "50%", maxHeight: "100%", nonCapturing: true },
			onHandle: (handle) => { this.handle = handle; },
		}).catch((error) => {
			if (mounted && this.panel === mounted) mounted.dispose();
			ctx.ui.notify(clean(error), "error");
		});
	}

	toggleFocus(): boolean {
		if (!this.handle) return false;
		if (this.handle.isFocused()) this.handle.unfocus();
		else this.handle.focus();
		return true;
	}

	dispose(): void {
		const { panel, close } = this;
		this.panel = this.handle = this.close = undefined;
		close?.(); // Ends ctx.ui.custom and removes the overlay, rather than just hiding it.
		panel?.dispose();
	}
}

/** Scrolls independently of the main transcript. Only the active viewer reads the log. */
class TranscriptPanel implements Component {
	focused = false;
	private target?: ViewTarget;
	private reader?: TailReader;
	private timer?: ReturnType<typeof setInterval>;
	private lines: string[] = [];
	private status = "";
	private cache?: { width: number; lines: string[] };
	private top?: number; // undefined follows the end; scrolling up pins the viewport.
	private lastTop = 0;
	private maxTop = 0;
	private page = 1;
	private discarded = false;
	private closed = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly close: () => void,
		private readonly unfocus: () => void,
		private readonly onDispose: () => void,
	) {}

	get id(): string | undefined { return this.target?.id; }

	select(target: ViewTarget): void {
		if (target.id === this.target?.id) return;
		this.target = target;
		this.reader = new TailReader(target.dir);
		this.lines = [""];
		this.top = undefined;
		this.discarded = false;
		this.status = "";
		this.invalidate();
		this.poll();
		this.timer ??= setInterval(() => this.poll(), POLL_MS);
		this.timer.unref?.();
	}

	private poll(): void {
		if (this.closed || !this.reader) return;
		let text = "", status: string;
		try {
			({ text, status } = this.reader.poll());
		} catch (error) {
			status = `Cannot read transcript: ${clean(error)}`;
		}
		if (text) {
			const parts = text.split("\n");
			const last = this.lines.length - 1;
			this.lines[last] = this.limitLine(this.lines[last] + parts[0]);
			for (let i = 1; i < parts.length; i++) this.lines.push(this.limitLine(parts[i]));
			if (this.lines.length > MAX_LINES) {
				const excess = this.lines.length - MAX_LINES;
				if (this.top !== undefined && this.cache)
					for (const line of this.lines.slice(0, excess))
						this.top = Math.max(0, this.top - this.wrap(line, this.cache.width).length);
				this.lines = this.lines.slice(excess);
				this.discarded = true;
			}
			this.invalidate();
		}
		if (text || status !== this.status) {
			this.status = status;
			this.tui.requestRender();
		}
	}

	private limitLine(line: string): string {
		return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS - 1) + "…" : line;
	}

	invalidate(): void { this.cache = undefined; }

	private wrap(line: string, width: number): string[] {
		return wrapTextWithAnsi(line, width).map((part) => truncateToWidth(part, width));
	}

	render(width: number): string[] {
		if (width < 5 || !this.target) return [];
		const height = this.tui.terminal.rows;
		const inner = width - 4;
		const content = this.cache?.width === inner ? this.cache.lines : this.lines.flatMap((line) => this.wrap(line, inner));
		this.cache = { width: inner, lines: content };
		this.page = Math.max(0, height - 4);
		this.maxTop = Math.max(0, content.length - this.page);
		this.lastTop = Math.min(this.top ?? this.maxTop, this.maxTop);
		const border = (text: string) => this.theme.fg(this.focused ? "accent" : "borderMuted", text);
		const row = (text: string) => {
			const clipped = truncateToWidth(text, inner);
			return border("│") + " " + clipped + " ".repeat(Math.max(0, inner + 1 - visibleWidth(clipped))) + border("│");
		};
		const title = `${clean(this.target.name)} · [${clean(this.target.profile)}]`;
		const mark = this.top === undefined ? "Live" : "Paused";
		const hint = this.focused ? "↑↓ PgUp/PgDn · End live · q close" : `Ctrl+Alt+D focus · ${mark}`;
		const status = this.status + (this.discarded ? " · Earlier lines omitted" : "");
		const lines = [row(this.theme.fg("accent", title)), row(this.theme.fg("muted", status))];
		for (let i = 0; i < this.page; i++) lines.push(row(content[this.lastTop + i] ?? ""));
		lines.push(row(this.theme.fg("muted", hint)), border("└" + "─".repeat(width - 2) + "┘"));
		return lines.slice(0, height);
	}

	private scroll(delta: number): void {
		const next = Math.min(this.maxTop, Math.max(0, this.lastTop + delta));
		this.top = next < this.maxTop ? next : undefined;
		this.lastTop = next;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) this.close();
		else if (matchesKey(data, "tab") || matchesKey(data, "ctrl+alt+d")) this.unfocus();
		else if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "down")) this.scroll(1);
		else if (matchesKey(data, "pageUp")) this.scroll(-this.page);
		else if (matchesKey(data, "pageDown")) this.scroll(this.page);
		else if (matchesKey(data, "home")) this.scroll(-Infinity);
		else if (matchesKey(data, "end")) this.scroll(Infinity);
	}

	handleMouse(event: TuiMouseEvent) {
		if (event.type !== "wheel") return undefined;
		this.scroll(event.wheelDelta ?? 0);
		return { handled: true };
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.timer);
		this.onDispose();
	}
}
