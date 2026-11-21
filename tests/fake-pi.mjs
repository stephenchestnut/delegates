import fs from "node:fs";
import path from "node:path";
import { request } from "../src/control.ts";
const bootstrap = JSON.parse(process.env.PI_DELEGATE_BOOTSTRAP);
const context = await request(bootstrap, "context");
await request(bootstrap, "ready");
const task = process.argv.at(-1);
const name = context.profile.role;
if (task.includes("WAIT_FOREVER"))
	await new Promise(() => {
		setInterval(() => {}, 1000);
	});
if (task.includes("FAIL_PROVIDER")) {
	console.log(
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "error", errorMessage: "authentication failed" },
		}),
	);
	process.exit(0);
}
if (task.includes("TRY_FORBIDDEN")) {
	try {
		await request(bootstrap, "delegate", { profile: "worker", name: "forbidden", task: "write" });
		throw Error("Policy bypass");
	} catch (e) {
		if (!e.message.includes("cannot delegate")) throw e;
	}
}
if (task.includes("RESEARCH_TEAM") && name === "thinktank") {
	for (const op of ["verify", "submit", "beginTool"]) {
		try {
			await request(bootstrap, op, op === "beginTool" ? { tool: "write", id: "forbidden" } : {});
			throw Error("Policy bypass");
		} catch (e) {
			if (!/not permitted|Only prmanagers/.test(e.message)) throw e;
		}
	}
	const results = await request(
		bootstrap,
		"parallel",
		["Siamese", "Persian", "Maine Coon"].map((breed) => ({
			profile: "thinker",
			name: breed,
			task: task.includes("TEAM_WAIT") ? "WAIT_FOREVER" : "TRY_FORBIDDEN",
		})),
	);
	if (results.some((r) => !r.success)) throw Error(JSON.stringify(results));
}
if (task.includes("NESTED") && name === "prmanager") {
	const child = await request(bootstrap, "delegate", {
		profile: "worker",
		name: "implementation",
		task: task.includes("NESTED_WAIT")
			? "WAIT_FOREVER"
			: task.includes("NESTED_THINKER")
				? "WRITE_FILE THINKER_HELP"
				: "WRITE_FILE",
	});
	if (!child.success) throw new Error(child.error);
}
if (task.includes("THINKER_HELP")) {
	const child = await request(bootstrap, "delegate", {
		profile: "thinker",
		name: "research",
		task: "Read source",
	});
	if (!child.success) throw Error(child.error);
}
if (task.includes("WRITE_FILE")) {
	await request(bootstrap, "beginTool", { tool: "write", id: "edit-1" });
	fs.writeFileSync(path.join(process.cwd(), "new.txt"), "candidate\n");
	await request(bootstrap, "endTool", { id: "edit-1" });
}
if (task.includes("SUBMIT")) {
	const v = await request(bootstrap, "verify");
	if (v.status !== "passed") throw Error(JSON.stringify(v));
	const d = await request(bootstrap, "submit", {
		summary: "Implement candidate",
		acceptanceNotes: "Required checks passed",
		limitations: [],
	});
	if (!["candidate-ready", "delivered"].includes(d.status)) throw Error(JSON.stringify(d));
}
console.log(
	JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: `${name} finished; codemode available: ${context.allowedTools.includes("codemode")}`,
				},
			],
			stopReason: "stop",
			usage: { input: 10, output: 5, cost: { total: 0.01 } },
		},
	}),
);
console.log(JSON.stringify({ type: "agent_settled", aborted: false }));
