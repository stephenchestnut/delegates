export function sanitize(value: unknown, multiline?: boolean): string;
export function summarizeCall(name: string, args: unknown, max?: number): string;
export function lastSentence(text: string, max?: number): string;
export interface Formatter {
	/** Feed one JSONL record; returns the terminal text to write for it. */
	push(record: string): string;
	/** Ends an unfinished streamed line. */
	flush(): string;
}
export function createFormatter(options?: {
	color?: boolean;
	/** Current pane width, read per record so resizes apply. */
	columns?: () => number | undefined;
}): Formatter;
