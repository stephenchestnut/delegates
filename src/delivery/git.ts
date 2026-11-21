import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Runtime } from "../runtime/interface.ts";

export async function git(
	runtime: Runtime,
	cwd: string,
	args: string[],
	signal?: AbortSignal,
	env?: NodeJS.ProcessEnv,
): Promise<string> {
	const r = await runtime.execute({
		executable: "git",
		args: [
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		cwd,
		signal,
		env,
		timeoutMs: 120_000,
	});
	if (r.code || r.interrupted || r.truncated)
		throw new Error(
			`git ${args[0]} failed: ${r.stderr || r.stdout || (r.interrupted ? "interrupted" : `exit ${r.code}`)}`,
		);
	return r.stdout.trimEnd();
}
export async function repoRoot(runtime: Runtime, cwd: string): Promise<string> {
	return fs.realpathSync(await git(runtime, cwd, ["rev-parse", "--show-toplevel"]));
}
/** Build a candidate tree with a disposable index; the real index and working files are untouched. */
export async function candidateTree(
	runtime: Runtime,
	cwd: string,
	stateDir: string,
	signal?: AbortSignal,
): Promise<string> {
	const index = path.join(stateDir, `index-${randomUUID()}`);
	const env = { GIT_INDEX_FILE: index };
	try {
		await git(runtime, cwd, ["read-tree", "HEAD"], signal, env);
		await git(runtime, cwd, ["add", "-A", "--", "."], signal, env);
		const entries = await git(runtime, cwd, ["ls-files", "--stage"], signal, env);
		if (/^160000 /m.test(entries))
			throw new Error("Submodules/nested repositories are not supported for managed delivery");
		return await git(runtime, cwd, ["write-tree"], signal, env);
	} finally {
		fs.rmSync(index, { force: true });
		fs.rmSync(`${index}.lock`, { force: true });
	}
}
export function githubRepository(url: string): string | undefined {
	const match =
		/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
			url,
		);
	return match?.[1];
}
