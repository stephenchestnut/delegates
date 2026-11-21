import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.ts";

// Opt in with an installed Pi executable; all model responses are local deterministic SSE.
const executable = process.env.PI_DELEGATES_TEST_PI;
const packageDir = fileURLToPath(new URL("../", import.meta.url));
for (const mode of ["on", "only"])
	test(
		`real Pi (${mode}): installed package runs nested delegates through codemode`,
		{ skip: !executable, timeout: 90_000 },
		async () => {
			const f = await fixture();
			const failures: string[] = [],
				roles = new Set<string>();
			const server = http.createServer(async (req, res) => {
				let body = "";
				for await (const chunk of req) body += chunk;
				try {
					const request = JSON.parse(body);
					const all = request.messages
						.map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
						.join("\n");
					const role = all.includes("You are a prmanager delegate.")
						? "prmanager"
						: all.includes("You are a worker delegate.")
							? "worker"
							: all.includes("You are a thinktank delegate.")
								? "thinktank"
								: all.includes("You are a thinker delegate.")
									? "thinker"
									: all.includes("You are a crmanager delegate.")
										? "crmanager"
										: "parent";
					roles.add(role);
					const toolMessages = request.messages.filter((m: any) => m.role === "tool");
					let code: string | undefined;
					if (toolMessages.length === 0) {
						if (role === "parent")
							code =
								'const r = await tools.delegate_parallel({tasks:[{profile:"prmanager",name:"implement",task:"Create new.txt and submit the verified candidate"},{profile:"thinktank",name:"cat-history",task:"Coordinate multiple thinkers to research cat breed histories using web search"},{profile:"crmanager",name:"review",task:"/review commit HEAD\\nFocus on source.txt"}]}); if(r.some(x=>!x.success)) throw Error(JSON.stringify(r)); text(r.map(x=>({success:x.success,delivery:x.delivery.status})));';
						if (role === "prmanager")
							code =
								'const r = await tools.delegate({profile:"worker",name:"write",task:"Create new.txt"}); if(!r.success) throw Error(JSON.stringify(r)); text(r.success);';
						if (role === "crmanager") {
							assert.match(all, /Please perform a code review/);
							assert.match(all, /Focus on source\.txt/);
							assert.match(all, /Delegated scope: Commit/);
							code = 'const r=await tools.delegate_review_diff({view:"patch",file:"source.txt"}); if(!JSON.stringify(r).includes("+original")) throw Error("wrong review diff"); for(const name of ["bash", "write", "edit", "web_search", "delegate", "delegate_verify", "delegate_submit"]) { let blocked=false; try { await tools[name]({}); } catch { blocked=true; } if(!blocked) throw Error("read-only bypass "+name); } text("read-only review");';
						}
						if (role === "worker")
							code = 'await tools.write({path:"new.txt",content:"candidate\\n"}); text("written");';
						if (role === "thinktank")
							code =
								'const rs = await tools.delegate_parallel({tasks:["Siamese","Persian","Maine Coon"].map(name=>({profile:"thinker",name,task:"Research breed history using web search"}))}); if(rs.some(r=>!r.success)) throw Error(JSON.stringify(rs)); text(rs.map(r=>r.summary));';
						if (role === "thinker")
							code =
								'const s=await tools.read({path:"source.txt"}); const research=await tools.web_search({query:"cat breed history"}); if(!research.sources.length) throw Error("missing sources"); let blocked=false; try { await tools.write({path:"forbidden.txt",content:"bad"}); } catch { blocked=true; } if(!blocked) throw Error("read-only bypass"); text({s,research});';
					} else if (role === "prmanager" && toolMessages.length === 1)
						code =
							'const v=await tools.delegate_verify({}); if(v.status!=="passed") throw Error(JSON.stringify(v)); const d=await tools.delegate_submit({summary:"Add candidate",acceptanceNotes:"File exists and checks pass",limitations:[]}); if(d.status!=="candidate-ready") throw Error(JSON.stringify(d)); text(d);';
					if (
						toolMessages.some((m: any) =>
							/Script failed|read-only bypass|Unknown tool|is not a function/.test(String(m.content)),
						)
					)
						failures.push(`${role}: ${JSON.stringify(toolMessages)}`);
					const chunk = (delta: any, finish_reason: any = null) =>
						`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
					res.writeHead(200, { "content-type": "text/event-stream" });
					if (code) {
						res.write(
							chunk({
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: `call-${role}-${toolMessages.length}`,
										type: "function",
										function: { name: "codemode", arguments: JSON.stringify({ code }) },
									},
								],
							}),
						);
						res.write(chunk({}, "tool_calls"));
					} else {
						res.write(chunk({ role: "assistant", content: "Verified smoke response" }));
						res.write(chunk({}, "stop"));
					}
					res.end("data: [DONE]\n\n");
				} catch (e) {
					failures.push(String(e));
					res.writeHead(500);
					res.end(String(e));
				}
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			try {
				const port = (server.address() as any).port;
				fs.writeFileSync(
					path.join(f.agent, "models.json"),
					JSON.stringify({
						providers: {
							localtest: {
								baseUrl: `http://127.0.0.1:${port}/v1`,
								api: "openai-completions",
								apiKey: "test-only",
								models: [
									{
										id: "test",
										name: "Test",
										reasoning: false,
										input: ["text"],
										contextWindow: 128000,
										maxTokens: 4096,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									},
								],
							},
						},
					}),
				);
				fs.writeFileSync(
					path.join(f.agent, "settings.json"),
					JSON.stringify({
						codemode: { mode },
						delegates: {
							profiles: {
								thinker: { model: "localtest/test" },
								thinktank: { model: "localtest/test" },
								worker: { model: "localtest/test" },
								prmanager: { model: "localtest/test", delivery: "candidate" },
								crmanager: { model: "localtest/test" },
							},
							reviewExtension: process.env.PI_DELEGATES_TEST_REVIEW ?? fileURLToPath(new URL("./fake-review.ts", import.meta.url)),
							environment: { checks: [{ name: "exists", command: "test -f new.txt" }] },
							extensions: [
								{
									path: fileURLToPath(new URL("./fake-search.ts", import.meta.url)),
									tools: ["web_search"],
									readOnly: true,
								},
							],
						},
					}),
				);
				const env = { PI_CODING_AGENT_DIR: f.agent, PI_OFFLINE: "1", PI_DELEGATE_BOOTSTRAP: undefined };
				const install = await f.runtime.execute({
					executable: executable!,
					args: ["install", packageDir],
					cwd: f.repo,
					env,
					timeoutMs: 15_000,
				});
				assert.equal(install.code, 0, install.stderr + install.stdout);
				const r = await f.runtime.execute({
					executable: executable!,
					args: [
						"--no-mcp",
						"--no-approve",
						"--no-skills",
						"--offline",
						"--tools",
						"codemode,delegate,delegate_parallel",
						"--mode",
						"json",
						"--no-session",
						"--model",
						"localtest/test",
						"Exercise delegates",
					],
					cwd: f.repo,
					env,
					timeoutMs: 80_000,
					maxOutputBytes: 1_000_000,
				});
				assert.equal(r.code, 0, r.stderr + r.stdout);
				const progress = r.stdout
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
					.filter(
						(event) =>
							event.type === "tool_execution_update" && event.partialResult?.details?.delegateDisplay,
					);
				assert.ok(progress.length > 0, `Expected structured delegate progress events\n${r.stderr}\n${r.stdout.slice(-6000)}`);
				const progressText = progress
					.flatMap((event) =>
						event.partialResult.content.filter((c: any) => c.type === "text").map((c: any) => c.text),
					)
					.join("\n");
				assert.match(progressText, /Searching/);
				assert.doesNotMatch(progressText, /not-run|not-requested|\x1b/);
				assert.deepEqual([...roles].sort(), ["crmanager", "parent", "prmanager", "thinker", "thinktank", "worker"]);
				assert.deepEqual(failures, [], failures.join("\n"));
				assert.equal(fs.existsSync(path.join(f.repo, "new.txt")), false);
				assert.equal(fs.existsSync(path.join(f.repo, "forbidden.txt")), false);
				const jobs = fs
					.readdirSync(path.join(f.agent, "delegates/jobs"))
					.map((id) =>
						JSON.parse(fs.readFileSync(path.join(f.agent, "delegates/jobs", id, "job.json"), "utf8")),
					);
				const prmanager = jobs.find((j) => j.profile.role === "prmanager");
				assert.equal(prmanager.delivery.status, "candidate-ready", JSON.stringify(prmanager));
				const reviewer = jobs.find(j => j.profile.role === "crmanager");
				assert.equal(reviewer.workspace.kind, "clone");
				assert.notEqual(reviewer.workspace.path, f.repo);
				assert.equal(reviewer.delivery.status, "not-requested");
				assert.equal(reviewer.verification.status, "not-run");
				assert.equal(reviewer.changedFiles, undefined);
				assert.equal(reviewer.summary, "Verified smoke response");
				const thinktank = jobs.find((j) => j.profile.role === "thinktank");
				assert.equal(thinktank.workspace.cwd, f.repo);
				assert.equal(thinktank.delivery.status, "not-requested");
				assert.equal(thinktank.verification.status, "not-run");
				assert.equal(
					jobs.filter((j) => j.parentId === thinktank.id && j.profile.role === "thinker").length,
					3,
				);
				assert.ok(
					jobs.every((j) => j.execution === "stopped"),
					JSON.stringify(jobs),
				);
			} finally {
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				await f.cleanup();
			}
		},
	);
