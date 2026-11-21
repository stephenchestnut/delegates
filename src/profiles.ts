import type { Config, Profile } from "./types.ts";

export const PARENT_GUIDANCE = `Use delegates for bounded work that benefits from a separate context. Choose thinker for individual read-only research/review, thinktank to coordinate several thinkers and synthesize a research report without Git or PR delivery, worker for a change in your current checkout, and prmanager for an independently implemented and verified PR in a private clone. Do small tasks directly. Give every delegate a short descriptive name and clear acceptance criteria. Use delegate_parallel for independent research or prmanagers that need one common starting commit. Never run concurrent writable workers in a shared checkout; while a worker runs, yield writes to it. PR managers publish only through explicit verified submission to an authorized repository. A successful process exit is not necessarily successful delivery. Inspect structured execution, verification, and delivery states.`;

export function allowedTools(profile: Profile, config: Config): string[] {
	const tools = ["read", "grep", "find", "ls", "codemode"];
	if (profile.permissions === "read-write") tools.push("bash", "edit", "write");
	if (profile.delegation.length) tools.push("delegate", "delegate_parallel");
	if (profile.role === "prmanager") tools.push("delegate_verify", "delegate_submit");
	for (const extension of config.extensions)
		if (profile.permissions === "read-write" || extension.readOnly) tools.push(...extension.tools);
	return [...new Set(tools)];
}
export function profilePrompt(profile: Profile, config: Config): string {
	const children = Object.entries(config.profiles)
		.filter(([, p]) => profile.delegation.includes(p.role))
		.map(([name]) => name);
	const common = [
		`You are a ${profile.role} delegate. Your configured workspace is ${profile.workspace}, runtime ${profile.runtime}, permissions ${profile.permissions}.`,
		"Complete only the delegated task. Return concise durable findings, evidence/file paths, checks actually run, limitations, and unresolved issues.",
		"Codemode is available to batch allowed tool calls and filter results. Await all calls; ending a script cancels outstanding work. Do not use short script deadlines for delegation.",
		"Tool-level host restrictions are not an OS sandbox. Do not bypass the configured tool/delegation policy using a shell, another process, or credentials.",
		children.length
			? `You may delegate only to these configured profiles: ${children.join(", ")}. Use descriptive names and focused tasks.`
			: "You cannot delegate to other agents.",
	];
	if (profile.permissions === "read-only")
		common.push(
			"Inspect only. Do not edit files, run shell commands, install packages, or make remote mutations. Research may observe concurrent changes; state uncertainty and avoid claiming a frozen review unless provided a verified candidate.",
		);
	if (profile.role === "thinktank")
		common.push(
			children.length
				? "Coordinate research, not code delivery. Break independent topics into focused thinker tasks and use delegate_parallel when useful. Thinkers cannot delegate further; do not spawn workers, prmanagers, or other thinktanks."
				: "Coordinate research, not code delivery. Delegation is disabled for this profile; research directly with permitted read-only tools and return a synthesized report.",
			"Ask thinkers for reliable sources, evidence, uncertainties, and clearly distinguished facts versus speculation. Synthesize their findings into a comparative report with citations. If web research is requested, use only configured/approved web tools; if unavailable, report that limitation instead of inventing sources.",
			"Use the caller's workspace as-is. No clone, tests/lint delivery gate, commit, or PR is required for this report-only profile.",
		);
	if (profile.role === "worker")
		common.push(
			"Your workspace is inherited from the caller, possibly a prmanager's private clone. Do not switch branches, commit, push, create PRs, or spawn coding workers. Delegate broad research to an allowed thinker. Report changes and tests; the caller owns integration.",
		);
	if (profile.role === "prmanager")
		common.push(
			"Own implementation and acceptance, not just delegation. Your workers share THIS clone. Only one coding worker may run at a time; yield writes while it runs. Thinkers can research concurrently.",
			"Do not commit, push, reset, switch branches, or manipulate PRs through Bash. Git delivery is controlled by delegate_submit. You may inspect Git history/diffs.",
			"After implementation: call delegate_verify. Fix failures and repeat verification. Check source changes invalidate prior verification. Missing check configuration is blocked, not success.",
			`Then call delegate_submit with summary, acceptanceNotes, and limitations. Delivery policy: ${profile.delivery}. Inspect its status; a PR with failing/pending checks is NOT delivered.`,
			"If CI fails, use the PR/log information to investigate, repair, verify, and resubmit within the configured attempt budget. Do not waive checks or rewrite check configuration to make delivery pass.",
			"After successful candidate-ready/delivered submission, do not edit further; report the candidate SHA/PR URL. If blocked, return an honest blocked report; exiting does not publish work.",
		);
	return common.join("\n\n");
}
