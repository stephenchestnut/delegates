export type Role = "thinker" | "thinktank" | "worker" | "prmanager";
export type DeliveryMode = "none" | "candidate" | "pr";
export interface Profile {
	role: Role;
	model: string;
	workspace: "shared" | "clone";
	runtime: "host" | "container";
	permissions: "read-only" | "read-write";
	delegation: Role[];
	timeoutMs: number;
	delivery: DeliveryMode;
}
export interface Check {
	name: string;
	command: string;
	timeoutMs: number;
}
export interface Environment {
	setup: Check[];
	checks: Check[];
	exemption?: string;
	allowedPaths?: string[];
}
export interface Publication {
	repository: string;
	remote: string;
	baseBranch: string;
	requiredChecks: string[];
	ciTimeoutMs: number;
	allowUnpublishedBase: boolean;
}
export interface Config {
	version: 1;
	profiles: Record<string, Profile>;
	maxParallel: number;
	maxThinkers: number;
	maxOutputBytes: number;
	maxTaskBytes: number;
	maxSubmissions: number;
	showStatusWidget: boolean;
	display: "compact" | "detailed";
	environment: Environment;
	publication?: Publication;
	extensions: { path: string; tools: string[]; readOnly: boolean }[];
}
export interface Invocation {
	profile: string;
	name: string;
	task: string;
	model?: string;
	base?: string;
	continue?: string;
}
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}
export const emptyUsage = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	turns: 0,
});
export interface Workspace {
	kind: "shared" | "clone";
	path: string;
	cwd: string;
	source: string;
	baseSha?: string;
	branch?: string;
	remoteUrl?: string;
	excludedDirtyChanges?: boolean;
}
export interface Verification {
	status: "not-run" | "running" | "passed" | "failed" | "stale" | "blocked";
	fingerprint?: string;
	policyHash?: string;
	checks: { name: string; code: number; log: string }[];
	error?: string;
}
export interface Delivery {
	status:
		| "not-requested"
		| "candidate-ready"
		| "publishing"
		| "pr-open"
		| "checks-pending"
		| "delivered"
		| "blocked"
		| "failed"
		| "no-changes";
	commitSha?: string;
	treeSha?: string;
	pushedSha?: string;
	prUrl?: string;
	error?: string;
}
export interface ContextSnapshot {
	/** Pi's estimate at the last sampled lifecycle boundary; null means unavailable. */
	tokens: number | null;
	contextWindow: number | null;
}
export interface Job {
	version: 1;
	id: string;
	parentId?: string;
	ownerSession: string;
	profileName: string;
	profile: Profile;
	config: Config;
	invocation: Invocation;
	workspace: Workspace;
	execution: "preparing" | "running" | "stopped" | "failed" | "cancelled" | "interrupted";
	startedAt: string;
	finishedAt?: string;
	summary: string;
	error?: string;
	usage: Usage;
	verification: Verification;
	delivery: Delivery;
	submissions: number;
	logDir: string;
	previousJobId?: string;
	/** Presentation identity and self usage; aggregate usage/result contracts are unchanged. */
	displayRunId?: string;
	displayParentRunId?: string;
	selfUsage?: Usage;
	contextSnapshot?: ContextSnapshot;
	changedFiles?: string[];
}
export interface DelegateResult {
	id: string;
	name: string;
	profile: string;
	model: string;
	execution: Job["execution"];
	success: boolean;
	summary: string;
	error?: string;
	workspace: Workspace;
	verification: Verification;
	delivery: Delivery;
	usage: Usage;
	logDir: string;
	changedFiles?: string[];
}
export function resultOf(job: Job): DelegateResult {
	const delivered =
		job.profile.delivery === "none" ||
		(job.profile.delivery === "candidate" && job.delivery.status === "candidate-ready") ||
		(job.profile.delivery === "pr" && job.delivery.status === "delivered");
	return {
		id: job.id,
		name: job.invocation.name,
		profile: job.profileName,
		model: job.profile.model,
		execution: job.execution,
		success: job.execution === "stopped" && delivered,
		summary: job.summary,
		error: job.error,
		workspace: job.workspace,
		verification: job.verification,
		delivery: job.delivery,
		usage: job.usage,
		logDir: job.logDir,
		changedFiles: job.changedFiles,
	};
}
export interface Bootstrap {
	version: 1;
	socket: string;
	token: string;
	jobId: string;
}
export interface ChildContext {
	profile: Profile;
	config: Config;
	allowedProfiles: string[];
	allowedTools: string[];
}
