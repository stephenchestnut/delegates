import {
	DefaultResourceLoader, SettingsManager, type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ChildContext } from "./types.ts";

/** Run the installed /review command in a fresh delegate session, without exposing its interactive UI. */
export async function reviewPrompt(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentDir: string,
	review: NonNullable<ChildContext["review"]>,
): Promise<string> {
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd, agentDir, settingsManager: SettingsManager.inMemory(),
		additionalExtensionPaths: [review.extension], noExtensions: true,
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await loader.reload();
	const { extensions, errors, runtime } = loader.getExtensions();
	const command = extensions.find(e => e.resolvedPath === review.extension || e.path === review.extension)?.commands.get("review");
	if (!command) throw new Error(`Cannot load /review from ${review.extension}${errors.length ? `: ${errors.map(e => e.error).join("; ")}` : ""}`);
	let prompt: string | undefined;
	// Capture the extension's real rubric and target prompt instead of copying them or starting a second model turn.
	runtime.appendEntry = (type, data) => pi.appendEntry(type, data);
	runtime.sendUserMessage = (content) => {
		if (typeof content !== "string" || !content.trim() || prompt) throw new Error("Unexpected /review prompt");
		prompt = content;
	};
	const unsupported = () => { throw new Error("The /review extension requested interactive input in a delegate"); };
	await command.handler(review.args, {
		...ctx,
		hasUI: true,
		getSystemPromptOptions: unsupported, waitForIdle: unsupported, newSession: unsupported,
		fork: unsupported, navigateTree: unsupported, switchSession: unsupported, reload: unsupported,
		ui: {
			...ctx.ui,
			notify: (message, level) => { if (level === "error") throw new Error(message); },
			select: unsupported, input: unsupported, editor: unsupported, custom: unsupported, confirm: unsupported,
		},
	});
	if (!prompt) throw new Error("/review did not produce a prompt");
	return `${prompt}\n\nDelegated scope: ${review.scope}${review.focus ? `\nCaller review focus:\n${review.focus}` : ""}\n\nUse delegate_review_diff for Git evidence. Report findings only; do not change code or post comments.`;
}
