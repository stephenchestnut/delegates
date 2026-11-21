import * as fs from "node:fs";
import * as path from "node:path";
import { parseReview } from "./review.ts";
import type { Check, Config, Invocation, Profile, Role } from "./types.ts";

export const DEFAULT_PROFILES: Record<Role, Profile> = {
	thinker: {
		role: "thinker",
		model: "openai-codex/gpt-6.1-sol:high",
		workspace: "shared",
		runtime: "host",
		permissions: "read-only",
		delegation: [],
		timeoutMs: 600_000,
		delivery: "none",
	},
	thinktank: {
		role: "thinktank",
		model: "openai-codex/gpt-6.1-sol:high",
		workspace: "shared",
		runtime: "host",
		permissions: "read-only",
		delegation: ["thinker"],
		timeoutMs: 600_000,
		delivery: "none",
	},
	worker: {
		role: "worker",
		model: "openai-codex/gpt-6-luna:medium",
		workspace: "shared",
		runtime: "host",
		permissions: "read-write",
		delegation: ["thinker"],
		timeoutMs: 600_000,
		delivery: "none",
	},
	prmanager: {
		role: "prmanager",
		model: "openai-codex/gpt-6.1-sol:high",
		workspace: "clone",
		runtime: "host",
		permissions: "read-write",
		delegation: ["worker", "thinker"],
		timeoutMs: 1_800_000,
		delivery: "pr",
	},
	crmanager: {
		role: "crmanager",
		model: "openai-codex/gpt-6.1-sol:high",
		workspace: "clone",
		runtime: "host",
		permissions: "read-only",
		delegation: [],
		timeoutMs: 1_800_000,
		delivery: "none",
	},
};
export const DEFAULT_CONFIG: Config = {
	version: 1,
	profiles: DEFAULT_PROFILES,
	maxParallel: 3,
	maxThinkers: 6,
	maxOutputBytes: 50_000,
	maxTaskBytes: 100_000,
	maxSubmissions: 3,
	showStatusWidget: true,
	display: "compact",
	environment: { setup: [], checks: [] },
	extensions: [],
};
function object(value: unknown, where: string): Record<string, any> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${where} must be an object`);
	return value as Record<string, any>;
}
function keys(value: Record<string, any>, allowed: string[], where: string) {
	for (const key of Object.keys(value))
		if (!allowed.includes(key)) throw new Error(`Unknown ${where} field: ${key}`);
}
function positive(value: unknown, name: string, max = 86_400_000): asserts value is number {
	if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max)
		throw new Error(`${name} must be an integer in 1..${max}`);
}
function text(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f-\x9f]/u.test(value))
		throw new Error(`Invalid ${name}`);
}
export function validateName(value: unknown): string {
	if (typeof value !== "string" || /[\x00-\x1f\x7f-\x9f]/u.test(value))
		throw new Error("Name must be text without control characters");
	const name = value.trim().replace(/\s+/g, " ");
	if (!name || name.length > 60) throw new Error("Name must contain 1–60 characters");
	return name;
}
export function readSettings(file: string): Record<string, any> {
	try {
		return object(JSON.parse(fs.readFileSync(file, "utf8")), file);
	} catch (error: any) {
		if (error.code === "ENOENT") return {};
		throw new Error(`Cannot load ${file}: ${error.message}`);
	}
}
/** Translate preferences, not the old shell allowlist or recursive-worker permission. */
export function legacyConfig(old: Record<string, any>): Record<string, any> {
	const profiles: Record<string, any> = {};
	for (const [role, key] of [
		["thinker", "thinkerModel"],
		["worker", "workerModel"],
		["prmanager", "branchWorkerModel"],
	]) {
		profiles[role] = {};
		if (old[key]) profiles[role].model = old[key];
		const timeout = role === "prmanager" ? old.branchWorkerTimeoutMs : old.childTimeoutMs;
		if (timeout) profiles[role].timeoutMs = timeout;
	}
	return {
		profiles,
		...(old.maxOutputBytes ? { maxOutputBytes: old.maxOutputBytes } : {}),
		...(old.maxParallelThinkers ? { maxThinkers: old.maxParallelThinkers } : {}),
		...(old.branchWorkerMaxContextBytes ? { maxTaskBytes: old.branchWorkerMaxContextBytes } : {}),
		...(typeof old.showStatusWidget === "boolean" ? { showStatusWidget: old.showStatusWidget } : {}),
	};
}
/** Read old manager settings/jobs as prmanager without rewriting files or weakening policy. */
export function normalizeProfileNames(input: unknown): Record<string, any> {
	const normalized = merge({}, object(input, "delegates"));
	if (normalized.profiles !== undefined) {
		const profiles = object(normalized.profiles, "profiles");
		if (Object.hasOwn(profiles, "manager")) {
			profiles.prmanager = merge(object(profiles.manager, "manager profile"), profiles.prmanager ?? {});
			delete profiles.manager;
		}
		for (const value of Object.values(profiles)) {
			const profile = object(value, "profile");
			if (profile.role === "manager") profile.role = "prmanager";
			if (profile.extends === "manager") profile.extends = "prmanager";
			if (Array.isArray(profile.delegation))
				profile.delegation = profile.delegation.map((role: unknown) =>
					role === "manager" ? "prmanager" : role,
				);
		}
	}
	return normalized;
}
function layer(settings: Record<string, any>): Record<string, any> {
	return merge(
		settings.subagents ? legacyConfig(object(settings.subagents, "subagents")) : {},
		normalizeProfileNames(settings.delegates ?? {}),
	);
}
function merge(a: any, b: any): any {
	object(b, "configuration");
	const result = { ...a };
	for (const [key, value] of Object.entries(b)) {
		if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid configuration key");
		result[key] =
			value && typeof value === "object" && !Array.isArray(value) ? merge(a?.[key] ?? {}, value) : value;
	}
	return result;
}
function checks(input: any, label: string): Check[] {
	if (!Array.isArray(input)) throw new Error(`${label} must be an array`);
	const names = new Set<string>();
	return input.map((c) => {
		object(c, label);
		keys(c, ["name", "command", "timeoutMs"], label);
		text(c.name, `${label}.name`);
		text(c.command, `${label}.command`);
		if (names.has(c.name)) throw new Error(`Duplicate check ${c.name}`);
		names.add(c.name);
		const timeoutMs = c.timeoutMs ?? 600_000;
		positive(timeoutMs, "check timeout");
		return { name: c.name, command: c.command, timeoutMs };
	});
}
export function resolveConfig(user: Record<string, any> = {}, project: Record<string, any> = {}): Config {
	const userLayer = layer(user),
		projectLayer = layer(project);
	// Executable extension loading and publication authorization belong to the user, not a repo.
	for (const key of ["extensions", "publication", "reviewExtension"])
		if (key in projectLayer) throw new Error(`delegates.${key} must be configured at user scope`);
	const raw = merge(merge(DEFAULT_CONFIG, userLayer), projectLayer);
	keys(raw, Object.keys(DEFAULT_CONFIG).concat("publication", "reviewExtension"), "delegates");
	if (raw.reviewExtension !== undefined) {
		text(raw.reviewExtension, "reviewExtension");
		if (!path.isAbsolute(raw.reviewExtension)) throw new Error("reviewExtension must be an absolute file path");
	}
	if (raw.version !== 1) throw new Error("Unsupported delegates configuration version");
	for (const key of ["maxParallel", "maxThinkers", "maxSubmissions"]) positive(raw[key], key, 32);
	positive(raw.maxOutputBytes, "maxOutputBytes", 1_000_000);
	positive(raw.maxTaskBytes, "maxTaskBytes", 1_000_000);
	if (typeof raw.showStatusWidget !== "boolean") throw new Error("showStatusWidget must be boolean");
	if (!["compact", "detailed"].includes(raw.display)) throw new Error("display must be compact or detailed");
	object(raw.profiles, "profiles");
	const profiles: Record<string, Profile> = {};
	for (const [name, value] of Object.entries(raw.profiles)) {
		if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error(`Invalid profile name: ${name}`);
		const p = object(value, name);
		keys(p, Object.keys(DEFAULT_PROFILES.worker).concat("extends"), name);
		const base = p.extends ?? p.role ?? name;
		if (!Object.hasOwn(DEFAULT_PROFILES, base))
			throw new Error(`${name}: extends must name thinker, thinktank, worker, prmanager, or crmanager`);
		const profile: Record<string, any> = { ...DEFAULT_PROFILES[base as Role], ...p };
		delete profile.extends;
		if (!Object.hasOwn(DEFAULT_PROFILES, profile.role)) throw new Error(`Invalid role: ${profile.role}`);
		if (name in DEFAULT_PROFILES && profile.role !== name)
			throw new Error(`Cannot change built-in role ${name}`);
		if (profile.runtime !== "host")
			throw new Error(
				`Runtime '${profile.runtime}' is not implemented; container execution is deferred. Use host.`,
			);
		if (!["shared", "clone"].includes(profile.workspace))
			throw new Error("Workspace must be shared or clone; worktrees are not implemented");
		if (!["read-only", "read-write"].includes(profile.permissions)) throw new Error("Invalid permissions");
		if (
			!Array.isArray(profile.delegation) ||
			profile.delegation.some((r: Role) => !DEFAULT_PROFILES[profile.role as Role].delegation.includes(r))
		)
			throw new Error(`${name}: delegation exceeds role ceiling`);
		if (
			["thinker", "thinktank"].includes(profile.role) &&
			(profile.permissions !== "read-only" || profile.workspace !== "shared")
		)
			throw new Error(`${profile.role} must be shared/read-only`);
		if (
			profile.role === "prmanager" &&
			(profile.workspace !== "clone" || profile.permissions !== "read-write")
		)
			throw new Error("PR manager must be clone/read-write");
		if (profile.role === "crmanager" && (profile.workspace !== "clone" || profile.permissions !== "read-only"))
			throw new Error("Code review manager must be clone/read-only");
		if (
			!["none", "candidate", "pr"].includes(profile.delivery) ||
			(profile.role !== "prmanager" && profile.delivery !== "none") ||
			(profile.role === "prmanager" && profile.delivery === "none")
		)
			throw new Error("Only prmanagers have delivery policies (candidate or pr)");
		if (profile.permissions === "read-only" && profile.delegation.some((r: Role) => r !== "thinker"))
			throw new Error("Read-only profiles cannot spawn writers");
		text(profile.model, "model");
		positive(profile.timeoutMs, "timeoutMs");
		profiles[name] = profile as Profile;
	}
	const environment = object(raw.environment, "environment");
	keys(environment, ["setup", "checks", "exemption", "allowedPaths"], "environment");
	if (environment.exemption !== undefined) text(environment.exemption, "exemption reason");
	if (
		environment.allowedPaths !== undefined &&
		(!Array.isArray(environment.allowedPaths) ||
			environment.allowedPaths.some(
				(p: unknown) =>
					typeof p !== "string" ||
					!p ||
					p.startsWith("/") ||
					p.includes("\\\\") ||
					p.split("/").includes("..") ||
					/[\x00-\x1f]/.test(p),
			))
	)
		throw new Error("allowedPaths must contain relative files or directory prefixes ending in /");
	raw.environment = {
		setup: checks(environment.setup, "setup"),
		checks: checks(environment.checks, "checks"),
		...(environment.exemption ? { exemption: environment.exemption } : {}),
		...(environment.allowedPaths !== undefined ? { allowedPaths: environment.allowedPaths } : {}),
	};
	if (raw.publication) {
		const p = object(raw.publication, "publication");
		keys(
			p,
			["repository", "remote", "baseBranch", "requiredChecks", "ciTimeoutMs", "allowUnpublishedBase"],
			"publication",
		);
		text(p.repository, "repository");
		if (!/^[\w.-]+\/[\w.-]+$/.test(p.repository))
			throw new Error("repository must be OWNER/REPO on github.com");
		p.remote ??= "origin";
		p.ciTimeoutMs ??= 600_000;
		p.allowUnpublishedBase ??= false;
		text(p.remote, "remote");
		if (!/^[a-zA-Z0-9][\w.-]*$/.test(p.remote)) throw new Error("Invalid remote name");
		text(p.baseBranch, "baseBranch");
		if (p.baseBranch.startsWith("-")) throw new Error("Invalid base branch");
		positive(p.ciTimeoutMs, "ciTimeoutMs");
		if (
			!Array.isArray(p.requiredChecks) ||
			p.requiredChecks.some((x: unknown) => typeof x !== "string" || !x.trim())
		)
			throw new Error("requiredChecks must explicitly list check names (or [] for no remote checks)");
		if (typeof p.allowUnpublishedBase !== "boolean") throw new Error("allowUnpublishedBase must be boolean");
	}
	if (!Array.isArray(raw.extensions)) throw new Error("extensions must be an array");
	for (const e of raw.extensions) {
		object(e, "extension");
		keys(e, ["path", "tools", "readOnly"], "extension");
		text(e.path, "extension path");
		if (!Array.isArray(e.tools) || e.tools.some((n: unknown) => typeof n !== "string" || !/^[\w-]+$/.test(n)))
			throw new Error("Invalid extension tools");
		if (typeof e.readOnly !== "boolean") throw new Error("extension.readOnly must be explicit");
		if (
			e.tools.some(
				(n: string) =>
					n.startsWith("delegate") || ["codemode", "read", "write", "edit", "grep", "find", "ls"].includes(n),
			)
		)
			throw new Error("Extensions cannot replace delegates, codemode, or file tools");
		if (e.readOnly && e.tools.includes("bash")) throw new Error("Bash cannot be marked read-only");
	}
	const resolved = JSON.parse(JSON.stringify({ ...raw, profiles })) as Config;
	if (Object.keys(projectLayer).length) {
		const ceiling = resolveConfig(user);
		for (const key of [
			"maxParallel",
			"maxThinkers",
			"maxSubmissions",
			"maxOutputBytes",
			"maxTaskBytes",
		] as const)
			if (resolved[key] > ceiling[key]) throw new Error(`Project ${key} exceeds user policy`);
		for (const [name, p] of Object.entries(resolved.profiles)) {
			const upper = ceiling.profiles[name] ?? ceiling.profiles[p.role];
			if (
				(upper.permissions === "read-only" && p.permissions !== "read-only") ||
				p.delegation.some((r) => !upper.delegation.includes(r)) ||
				p.timeoutMs > upper.timeoutMs ||
				(upper.delivery === "candidate" && p.delivery === "pr")
			)
				throw new Error(`Project profile ${name} exceeds user policy`);
		}
		for (const check of ceiling.environment.checks)
			if (
				!resolved.environment.checks.some(
					(c) => c.name === check.name && c.command === check.command && c.timeoutMs <= check.timeoutMs,
				)
			)
				throw new Error(`Project cannot remove or replace user check ${check.name}`);
		if (
			ceiling.environment.allowedPaths &&
			(!resolved.environment.allowedPaths ||
				resolved.environment.allowedPaths.some(
					(entry) =>
						!ceiling.environment.allowedPaths!.some((upper) =>
							upper.endsWith("/") ? entry.startsWith(upper) : entry === upper,
						),
				))
		)
			throw new Error("Project allowedPaths exceeds user scope");
	}
	return resolved;
}
export function loadConfig(agentDir: string, cwd: string, trusted: boolean): Config {
	return resolveConfig(
		readSettings(path.join(agentDir, "settings.json")),
		trusted ? readSettings(path.join(cwd, ".pi/settings.json")) : {},
	);
}
export function validateInvocation(input: unknown, config: Config, parent?: Profile): Invocation {
	const v = object(input, "invocation");
	keys(v, ["profile", "name", "task", "model", "base", "continue"], "invocation");
	const profile = config.profiles[v.profile];
	if (!profile) throw new Error(`Unknown profile: ${v.profile}`);
	if (parent && !parent.delegation.includes(profile.role))
		throw new Error(`${parent.role} cannot delegate to ${profile.role}`);
	if (typeof v.task !== "string" || !v.task.trim() || Buffer.byteLength(v.task) > config.maxTaskBytes)
		throw new Error("Task is empty or too large");
	if (v.model !== undefined) text(v.model, "model");
	for (const key of ["base", "continue"]) if (v[key] !== undefined) text(v[key], key);
	if (v.continue && profile.role === "crmanager") throw new Error("Start a fresh crmanager review instead of continuing");
	if (v.continue && !/^[a-f0-9-]{36}$/.test(v.continue)) throw new Error("Invalid continuation job ID");
	if (v.base && (profile.workspace !== "clone" || v.continue))
		throw new Error("base requires a new clone workspace");
	const invocation = { ...v, name: validateName(v.name) } as Invocation;
	if (profile.role === "crmanager") parseReview(invocation);
	return invocation;
}
export function migrateSettings(file: string): string {
	const settings = readSettings(file);
	const oldProfileNames =
		JSON.stringify(normalizeProfileNames(settings.delegates ?? {})) !==
		JSON.stringify(settings.delegates ?? {});
	if (!settings.subagents && !oldProfileNames) return "No legacy subagents or manager profile settings found";
	const config = resolveConfig(settings);
	const backup = `${file}.delegates-backup-${Date.now()}`;
	fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
	settings.delegates = config;
	delete settings.subagents;
	const temp = `${file}.delegates-${process.pid}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
	fs.renameSync(temp, file);
	return `Migrated settings; backup: ${backup}. manager profiles/references are now prmanager. Legacy shell allowlists, recursive workers, clone-root and implicit publication were not migrated. Configure approved extensions/publication explicitly.`;
}
