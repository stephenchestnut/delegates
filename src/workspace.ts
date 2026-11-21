import * as fs from "node:fs";
import * as path from "node:path";
import type { Runtime } from "./runtime/interface.ts";
import type { Workspace } from "./types.ts";
import { git, repoRoot } from "./delivery/git.ts";

export interface Base {
	root: string;
	sha: string;
	subdir: string;
	excludedDirtyChanges: boolean;
}
export function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return (
		relative !== "" &&
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}
export async function resolveBase(runtime: Runtime, cwd: string, ref?: string): Promise<Base> {
	const root = await repoRoot(runtime, cwd);
	const dirty = !!(await git(runtime, root, ["status", "--porcelain"], undefined, { GIT_OPTIONAL_LOCKS: "0" }));
	if (dirty && !ref)
		throw new Error(
			"Parent checkout is dirty. Commit changes, or explicitly select a committed base (dirty changes will be excluded).",
		);
	const sha = await git(runtime, root, [
		"rev-parse",
		"--verify",
		"--end-of-options",
		`${ref ?? "HEAD"}^{commit}`,
	]);
	const subdir = path.relative(root, fs.realpathSync(cwd));
	return { root, sha, subdir, excludedDirtyChanges: dirty };
}
export async function createClone(
	runtime: Runtime,
	base: Base,
	stateDir: string,
	id: string,
	name: string,
	remote: string,
	signal: AbortSignal,
): Promise<Workspace> {
	const target = path.join(stateDir, "workspace");
	if (target === base.root || inside(base.root, target))
		throw new Error("Delegates state directory must be outside the source repository");
	if (fs.existsSync(target)) throw new Error("Workspace already exists; use explicit continuation");
	// --no-local avoids hardlinks and metadata sharing; never use alternates/shared clones.
	await git(runtime, base.root, ["clone", "--no-local", "--no-hardlinks", "--", base.root, target], signal);
	const slug = name.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join("-") || "job";
	const branch = `delegates/${slug}-${id.slice(0, 8)}`;
	try {
		await git(runtime, target, ["cat-file", "-e", `${base.sha}^{commit}`], signal);
	} catch {
		// A pinned base may only be reachable from a source remote-tracking ref.
		await git(runtime, target, ["fetch", "--no-tags", "--", base.root, base.sha], signal);
	}
	await git(runtime, target, ["checkout", "-b", branch, base.sha], signal);
	let remoteUrl: string | undefined;
	try {
		remoteUrl = await git(runtime, base.root, ["remote", "get-url", remote], signal);
	} catch {
		/* local candidates need no remote */
	}
	if (remoteUrl && /^https?:\/\/[^/]*@/.test(remoteUrl))
		throw new Error(
			"Remote URLs containing embedded credentials are unsupported; use a credential helper instead",
		);
	await git(runtime, target, ["remote", "remove", "origin"], signal);
	if (remoteUrl) await git(runtime, target, ["remote", "add", remote, remoteUrl], signal);
	const cwd = path.join(target, base.subdir);
	if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
		throw new Error("Caller subdirectory does not exist at the selected base");
	fs.writeFileSync(path.join(stateDir, "workspace-owner.json"), JSON.stringify({ id, path: target }), {
		mode: 0o600,
	});
	return {
		kind: "clone",
		path: target,
		cwd,
		source: base.root,
		baseSha: base.sha,
		branch,
		remoteUrl,
		excludedDirtyChanges: base.excludedDirtyChanges,
	};
}
export async function validateWorkspace(
	runtime: Runtime,
	workspace: Workspace,
	expectedHead: string,
	remote: string,
	signal?: AbortSignal,
): Promise<void> {
	if (workspace.kind !== "clone") throw new Error("Delivery requires an owned clone");
	if ((await repoRoot(runtime, workspace.path)) !== fs.realpathSync(workspace.path))
		throw new Error("Repository identity changed");
	if ((await git(runtime, workspace.path, ["symbolic-ref", "--short", "HEAD"], signal)) !== workspace.branch)
		throw new Error("Assigned branch changed");
	if ((await git(runtime, workspace.path, ["rev-parse", "HEAD"], signal)) !== expectedHead)
		throw new Error("HEAD changed outside managed delivery");
	if (
		workspace.remoteUrl &&
		(await git(runtime, workspace.path, ["remote", "get-url", remote], signal)) !== workspace.remoteUrl
	)
		throw new Error("Remote URL changed");
}
