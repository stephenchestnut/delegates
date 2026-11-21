import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConfig, validateName, validateInvocation, migrateSettings } from "../src/config.ts";
import { allowedTools, profilePrompt } from "../src/profiles.ts";
import { fixture } from "./helpers.ts";

test("built-in profiles default to GPT-6.2 models with high thinking", () => {
	const { profiles } = resolveConfig();
	assert.deepEqual(Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, profile.model])), {
		thinker: "openai/gpt-6.2-sol:high",
		thinktank: "openai/gpt-6.2-sol:high",
		worker: "openai/gpt-6.2-sol:high",
		prmanager: "openai/gpt-6.2-sol:high",
		crmanager: "openai/gpt-6.2-astra:high",
	});
});

test("profiles are one configurable base with bounded delegation", () => {
	const c = resolveConfig();
	assert.equal(c.profiles.prmanager.workspace, "clone");
	assert.equal(c.profiles.manager, undefined);
	assert.equal(c.profiles.thinktank.workspace, "shared");
	assert.equal(c.profiles.thinktank.runtime, "host");
	assert.equal(c.profiles.thinktank.permissions, "read-only");
	assert.deepEqual(c.profiles.thinktank.delegation, ["thinker"]);
	assert.equal(c.profiles.thinktank.delivery, "none");
	assert.deepEqual(c.profiles.worker.delegation, ["thinker"]);
	assert.deepEqual(c.profiles.thinker.delegation, []);
	const custom = resolveConfig({
		delegates: {
			profiles: { experiment: { extends: "prmanager", delivery: "candidate", model: "inherit" } },
		},
	});
	assert.equal(custom.profiles.experiment.delivery, "candidate");
	assert.equal(custom.profiles.experiment.workspace, "clone");
});
test("container runtime rejected explicitly; role and executable policy ceilings enforced", () => {
	for (const p of [
		{ runtime: "container" },
		{ runtime: "vm" },
		{ delegation: ["prmanager"] },
		{ permissions: "read-write" },
	]) {
		assert.throws(() => resolveConfig({ delegates: { profiles: { thinker: p } } }));
	}
	assert.throws(() => resolveConfig({}, { delegates: { publication: {} } }), /user scope/);
	assert.throws(() => resolveConfig({}, { delegates: { extensions: [] } }), /user scope/);
	assert.throws(() => resolveConfig({ delegates: { typo: true } }), /Unknown/);
	assert.throws(() => resolveConfig({ delegates: { maxThinkers: 0 } }));
	assert.throws(() => resolveConfig({ delegates: { profiles: { worker: { role: "prmanager" } } } }));
});
test("thinktank cannot escalate permissions, publish, clone, or recursively coordinate", () => {
	for (const p of [
		{ permissions: "read-write" },
		{ workspace: "clone" },
		{ delivery: "pr" },
		{ delegation: ["thinktank"] },
		{ delegation: ["worker"] },
		{ delegation: ["prmanager"] },
	]) {
		assert.throws(() => resolveConfig({ delegates: { profiles: { thinktank: p } } }));
	}
	const c = resolveConfig();
	for (const profile of ["thinktank", "worker", "prmanager"])
		assert.throws(() => validateInvocation({ profile, name: "bad", task: "bad" }, c, c.profiles.thinktank));
	assert.equal(
		validateInvocation({ profile: "thinker", name: "research", task: "research" }, c, c.profiles.thinktank)
			.profile,
		"thinker",
	);
	assert.throws(
		() => validateInvocation({ profile: "manager", name: "old", task: "old" }, c),
		/Unknown profile/,
	);
});
test("crmanager and custom review profiles must remain read-only, clone-based and report-only", () => {
	for (const overrides of [
		{ workspace: "shared" }, { permissions: "read-write" }, { delivery: "candidate" },
		{ delivery: "pr" }, { delegation: ["worker"] }, { delegation: ["thinker"] },
	]) {
		assert.throws(() => resolveConfig({ delegates: { profiles: { review: { extends: "crmanager", ...overrides } } } }));
	}
	const config = resolveConfig({ delegates: {
		reviewExtension: "/trusted/review.ts",
		extensions: [{ path: "/other", tools: ["web_search"], readOnly: true }],
	} });
	assert.deepEqual(allowedTools(config.profiles.crmanager, config), ["read", "grep", "find", "ls", "codemode", "delegate_review_diff"]);
	assert.equal(config.profiles.crmanager.delivery, "none");
	assert.equal(config.profiles.crmanager.workspace, "clone");
	assert.equal(config.profiles.crmanager.permissions, "read-only");
	assert.throws(() => resolveConfig({}, { delegates: { reviewExtension: "/untrusted/review.ts" } }), /user scope/);
	assert.throws(() => resolveConfig({ delegates: { reviewExtension: "relative/review.ts" } }), /absolute/);
});

test("manager settings and references normalize to prmanager; new settings win", () => {
	const input = {
		delegates: {
			profiles: {
				manager: { model: "old/model", timeoutMs: 12345, delegation: ["thinker"] },
				prmanager: { model: "new/model" },
				experiment: { extends: "manager", delivery: "candidate" },
				coordinator: { role: "manager", delivery: "candidate" },
			},
		},
	};
	const c = resolveConfig(input);
	assert.equal(c.profiles.manager, undefined);
	assert.equal(c.profiles.prmanager.model, "new/model");
	assert.equal(c.profiles.prmanager.timeoutMs, 12345);
	assert.deepEqual(c.profiles.prmanager.delegation, ["thinker"]);
	assert.equal(c.profiles.experiment.role, "prmanager");
	assert.equal(c.profiles.coordinator.role, "prmanager");
	assert.equal(input.delegates.profiles.experiment.extends, "manager");
	assert.throws(
		() =>
			resolveConfig(
				{ delegates: { profiles: { manager: { delegation: [] } } } },
				{ delegates: { profiles: { prmanager: { delegation: ["worker"] } } } },
			),
		/user policy/,
	);
});
test("trusted project defaults cannot broaden user ceilings or replace required checks", () => {
	assert.throws(
		() => resolveConfig({ delegates: { maxParallel: 1 } }, { delegates: { maxParallel: 2 } }),
		/user policy/,
	);
	assert.throws(
		() =>
			resolveConfig(
				{ delegates: { profiles: { worker: { delegation: [] } } } },
				{ delegates: { profiles: { worker: { delegation: ["thinker"] } } } },
			),
		/user policy/,
	);
	assert.throws(
		() =>
			resolveConfig(
				{ delegates: { environment: { checks: [{ name: "test", command: "npm test" }] } } },
				{ delegates: { environment: { checks: [] } } },
			),
		/remove or replace/,
	);
	assert.throws(
		() =>
			resolveConfig(
				{ delegates: { environment: { allowedPaths: ["src/"] } } },
				{ delegates: { environment: { allowedPaths: ["tests/"] } } },
			),
		/scope/,
	);
});
test("legacy settings preserve model preferences but never migrate dangerous capabilities", () => {
	const c = resolveConfig({
		subagents: {
			workerModel: "old/model",
			branchWorkerModel: "inherit",
			thinkerTools: ["bash"],
			allowWorkerToSpawnWorkers: true,
		},
		delegates: { profiles: { worker: { model: "new/model" } } },
	});
	assert.equal(c.profiles.worker.model, "new/model");
	assert.equal(c.profiles.prmanager.model, "inherit");
	assert.deepEqual(c.profiles.worker.delegation, ["thinker"]);
	assert.ok(!allowedTools(c.profiles.thinker, c).includes("bash"));
});
test("names, invocations and child escalation are validated before launch", () => {
	const c = resolveConfig();
	assert.equal(validateName("  API   review  "), "API review");
	for (const n of ["", " ", undefined, "a".repeat(61), "bad\nname", "bad\x85name"])
		assert.throws(() => validateName(n));
	for (const role of ["thinker", "thinktank", "worker", "prmanager"])
		assert.throws(() => validateInvocation({ profile: role, name: "x", task: "x" }, c, c.profiles.thinker));
	assert.throws(() => validateInvocation({ profile: "worker", name: "x", task: "x", base: "HEAD" }, c));
	assert.throws(() =>
		validateInvocation({ profile: "thinker", name: "x", task: "x", permissions: "read-write" }, c),
	);
});
test("codemode and guidance respect each profile's tool and delegation surface", () => {
	const c = resolveConfig();
	for (const p of Object.values(c.profiles)) assert.ok(allowedTools(p, c).includes("codemode"));
	const thinker = allowedTools(c.profiles.thinker, c);
	assert.ok(!thinker.includes("delegate"));
	assert.ok(!thinker.includes("edit"));
	assert.match(profilePrompt(c.profiles.thinker, c), /cannot delegate/);
	assert.match(profilePrompt(c.profiles.prmanager, c), /delegate_verify/);
	const thinktank = allowedTools(c.profiles.thinktank, c);
	assert.ok(thinktank.includes("delegate") && thinktank.includes("delegate_parallel"));
	for (const tool of ["bash", "edit", "write", "delegate_verify", "delegate_submit"])
		assert.ok(!thinktank.includes(tool));
	assert.match(profilePrompt(c.profiles.thinktank, c), /Coordinate research/);
	assert.match(profilePrompt(c.profiles.thinktank, c), /comparative report with citations/);
	const readonly = resolveConfig({ delegates: { profiles: { worker: { permissions: "read-only" } } } });
	assert.ok(!allowedTools(readonly.profiles.worker, readonly).includes("bash"));
});
test("explicit migration also supports manager-only settings without subagents", async () => {
	const f = await fixture();
	try {
		const file = path.join(f.agent, "settings.json");
		fs.writeFileSync(
			file,
			JSON.stringify({ theme: "dark", delegates: { profiles: { manager: { model: "old/model" } } } }),
		);
		assert.match(migrateSettings(file), /manager profiles\/references are now prmanager/);
		const migrated = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(migrated.theme, "dark");
		assert.equal(migrated.delegates.profiles.prmanager.model, "old/model");
		assert.equal(migrated.delegates.profiles.manager, undefined);
		assert.match(migrateSettings(file), /No legacy/);
	} finally {
		await f.cleanup();
	}
});
test("explicit migration backs up and preserves unrelated settings", async () => {
	const f = await fixture();
	try {
		const file = path.join(f.agent, "settings.json");
		fs.writeFileSync(file, JSON.stringify({ theme: "dark", subagents: { workerModel: "old/model" } }));
		assert.match(migrateSettings(file), /backup/);
		const s = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(s.theme, "dark");
		assert.equal(s.subagents, undefined);
		assert.equal(s.delegates.profiles.worker.model, "old/model");
		assert.equal(fs.readdirSync(f.agent).filter((p) => p.includes("backup")).length, 1);
	} finally {
		await f.cleanup();
	}
});
