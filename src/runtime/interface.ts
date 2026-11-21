export interface Command {
	executable: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	timeoutMs?: number;
	log?: string;
	onStdout?: (chunk: string) => void;
	maxOutputBytes?: number;
}
export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
	interrupted: boolean;
	truncated: boolean;
}
/** Whole-process boundary. Future containers must also place nested agents and verification here. */
export interface Runtime {
	readonly kind: string;
	execute(command: Command): Promise<CommandResult>;
	shutdown(): Promise<void>;
}
