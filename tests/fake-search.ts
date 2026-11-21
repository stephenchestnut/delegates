import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Offline fixture only: exercises approved web-tool access without making network requests. */
export default function fakeSearch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Fixture search",
		description: "Return a deterministic test source; never contacts a search provider.",
		parameters: Type.Object({ query: Type.String() }),
		outputSchema: Type.Object({
			sources: Type.Array(Type.Object({ title: Type.String(), url: Type.String() })),
		}),
		async execute(_id, { query }) {
			const result = {
				sources: [{ title: `Test fixture: ${query}`, url: "https://example.invalid/cat-history" }],
			};
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
				structuredContent: result,
			};
		},
	});
}
