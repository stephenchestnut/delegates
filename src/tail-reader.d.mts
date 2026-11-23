import type { Job } from "./types.ts";
import type { createFormatter } from "./transcript.mjs";

export class TailReader {
	constructor(dir: string, options?: Parameters<typeof createFormatter>[0]);
	poll(budget?: number): { text: string; more: boolean; status: string; complete?: boolean };
	job(): Job | undefined;
	flush(): string;
}
