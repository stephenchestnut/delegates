import { visibleRuns, type DisplayRun } from "./display.ts";

export interface Clock {
	now(): number;
	everySecond(callback: () => void): unknown;
	cancel(handle: unknown): void;
}
const defaultClock: Clock = {
	now: Date.now,
	everySecond(callback) {
		const timer = setInterval(callback, 1000);
		timer.unref?.();
		return timer;
	},
	cancel(handle) {
		clearInterval(handle as ReturnType<typeof setInterval>);
	},
};
/** A render-only clock: never emits progress, changes job state, or writes manifests. */
export class DisplayClock {
	private runs: DisplayRun[] = [];
	private timer?: unknown;
	private mounted = false;
	private closed = false;
	private hooks: { mount(): void; clear(): void; render(): void };
	private clock: Clock;
	constructor(hooks: { mount(): void; clear(): void; render(): void }, clock: Clock = defaultClock) {
		this.hooks = hooks;
		this.clock = clock;
	}
	update(runs: DisplayRun[]): void {
		if (!this.closed) {
			this.runs = runs;
			this.refresh();
		}
	}
	now(): number {
		return this.clock.now();
	}
	visible(): DisplayRun[] {
		return visibleRuns(this.runs, this.clock.now());
	}
	private stop(): void {
		if (this.timer !== undefined) {
			this.clock.cancel(this.timer);
			this.timer = undefined;
		}
	}
	private refresh(): void {
		if (this.closed) return;
		if (!this.visible().length) {
			this.stop();
			if (this.mounted) {
				this.mounted = false;
				this.hooks.clear();
			}
			return;
		}
		if (!this.mounted) {
			this.mounted = true;
			this.hooks.mount();
		}
		this.hooks.render();
		this.timer ??= this.clock.everySecond(() => this.refresh());
	}
	/** Called by Pi if the widget is removed/replaced externally. */
	detach(): void {
		this.stop();
		this.mounted = false;
	}
	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.stop();
		this.runs = [];
		if (this.mounted) {
			this.mounted = false;
			this.hooks.clear();
		}
	}
}
