import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Exercise the same interactive guard, anchor and prompt call as pi-review. */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("review", {
		description: "Review fixture",
		async handler(args, ctx) {
			if (!ctx.hasUI) throw new Error("Missing interactive bridge");
			if (ctx.sessionManager.getEntries().some(entry => entry.type === "message")) throw new Error("Not a fresh review session");
			pi.appendEntry("review-anchor", {});
			if (!ctx.sessionManager.getLeafId()) throw new Error("Missing review anchor");
			const result = await pi.exec("git", ["rev-parse", "--git-dir"]);
			if (result.code || !/^commit [a-f0-9]+$/.test(args)) throw new Error(`Unexpected review target: ${args}`);
			pi.sendUserMessage(`Please perform a code review with fixture rubric: ${args}`);
		},
	});
}
