import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HostRuntime } from "../src/runtime/host.ts";
import { git } from "../src/delivery/git.ts";
import type { Command } from "../src/runtime/interface.ts";
export class TestRuntime extends HostRuntime {
	override execute(c: Command) {
		return super.execute({
			...c,
			env: {
				GIT_AUTHOR_NAME: "Delegate Test",
				GIT_AUTHOR_EMAIL: "test@example.invalid",
				GIT_COMMITTER_NAME: "Delegate Test",
				GIT_COMMITTER_EMAIL: "test@example.invalid",
				...c.env,
			},
		});
	}
}
export async function fixture() {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delegates-test-")));
	const repo = path.join(dir, "repo"),
		agent = path.join(dir, "agent");
	fs.mkdirSync(repo);
	fs.mkdirSync(agent);
	const runtime = new TestRuntime();
	await git(runtime, repo, ["init", "-b", "main"]);
	fs.writeFileSync(path.join(repo, "source.txt"), "original\n");
	fs.mkdirSync(path.join(repo, "src"));
	fs.writeFileSync(path.join(repo, "src", "index.txt"), "base\n");
	await git(runtime, repo, ["add", "."]);
	await git(runtime, repo, ["commit", "-m", "base"]);
	return {
		dir,
		repo,
		agent,
		runtime,
		async cleanup() {
			await runtime.shutdown();
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}
