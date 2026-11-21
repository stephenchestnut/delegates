import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
let piRoot = process.env.PI_DELEGATES_PI_ROOT;
if (!piRoot) {
	try {
		piRoot = path.dirname(require.resolve("@earendil-works/pi-coding-agent/package.json"));
	} catch {
		const install = process.env.PI_MANAGED_INSTALL_ROOT || path.join(os.homedir(), ".pi/agent/install");
		const version = fs.readFileSync(path.join(install, "current-version"), "utf8").trim();
		piRoot = path.join(install, "releases", version, "node_modules/@earendil-works/pi-coding-agent");
	}
}
const hostRequire = createRequire(path.join(piRoot, "package.json"));
const typebox = hostRequire
	.resolve("typebox")
	.replace(/\.mjs$/, ".d.mts")
	.replace(/\.js$/, ".d.ts");
const nodeTypes = path.dirname(hostRequire.resolve("@types/node/package.json"));
let tsc = process.env.PI_DELEGATES_TSC;
if (!tsc) {
	try {
		tsc = require.resolve("typescript/bin/tsc");
	} catch {
		throw Error(
			"Install dev dependencies with npm install --ignore-scripts --legacy-peer-deps, or set PI_DELEGATES_TSC to typescript/bin/tsc.",
		);
	}
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegates-typecheck-"));
try {
	const config = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));
	config.include = [path.join(root, "**/*.ts")];
	config.compilerOptions.baseUrl = root;
	config.compilerOptions.typeRoots = [path.dirname(nodeTypes)];
	config.compilerOptions.paths = {
		"@earendil-works/pi-coding-agent": [path.join(piRoot, "dist/index.d.ts")],
		"@earendil-works/pi-tui": [hostRequire.resolve("@earendil-works/pi-tui").replace(/\.js$/, ".d.ts")],
		typebox: [typebox],
	};
	const file = path.join(dir, "tsconfig.json");
	fs.writeFileSync(file, JSON.stringify(config));
	const r = spawnSync(process.execPath, [tsc, "-p", file], { stdio: "inherit" });
	if (r.error) throw r.error;
	process.exitCode = r.status ?? 1;
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
