#!/usr/bin/env node
/**
 * Link a local `node_modules` at an already-installed pi, so the tests can
 * import the exact packages pi supplies to extensions at runtime.
 *
 * Nothing is downloaded and nothing is installed. If a real (non-symlink)
 * package is already present it is left untouched, so `npm install` still wins.
 */
import { execSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = "@earendil-works";
const NEEDED = ["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"];

function candidates() {
	const out = [];
	if (process.env.PI_PACKAGE_DIR) out.push(process.env.PI_PACKAGE_DIR);
	try {
		const root = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		if (root) out.push(path.join(root, SCOPE, "pi-coding-agent"));
	} catch {
		/* no npm on PATH */
	}
	out.push(`/usr/local/lib/node_modules/${SCOPE}/pi-coding-agent`);
	out.push(`/opt/homebrew/lib/node_modules/${SCOPE}/pi-coding-agent`);
	return out;
}

const piDir = candidates().find((dir) => dir && existsSync(path.join(dir, "package.json")));
if (!piDir) {
	console.error(
		"[setup] could not find an installed pi package.\n" +
			"        Set PI_PACKAGE_DIR to .../node_modules/@earendil-works/pi-coding-agent and retry.",
	);
	process.exit(1);
}

const scopeDir = path.dirname(piDir);

function resolvePackage(name) {
	for (const candidate of [
		path.join(piDir, "node_modules", SCOPE, name),
		path.join(scopeDir, name),
	]) {
		if (existsSync(path.join(candidate, "package.json"))) return candidate;
	}
	return null;
}

/** Create node_modules/<name> as a symlink, unless a real install is already there. */
function link(src, dest) {
	try {
		if (!lstatSync(dest).isSymbolicLink()) return "kept";
		rmSync(dest, { force: true });
	} catch {
		/* nothing there */
	}
	symlinkSync(src, dest, "dir");
	return "linked";
}

const nodeModules = path.join(repoRoot, "node_modules");
mkdirSync(path.join(nodeModules, SCOPE), { recursive: true });

const linked = [];
for (const name of NEEDED) {
	const src = resolvePackage(name);
	if (!src) {
		console.warn(`[setup] skip ${SCOPE}/${name} (not found next to ${piDir})`);
		continue;
	}
	link(src, path.join(nodeModules, SCOPE, name));
	linked.push(`${SCOPE}/${name}`);
}

const jiti = path.join(piDir, "node_modules", "jiti");
if (existsSync(path.join(jiti, "package.json"))) {
	link(jiti, path.join(nodeModules, "jiti"));
	linked.push("jiti");
}

console.log(`[setup] pi package: ${piDir}`);
console.log(`[setup] linked into node_modules: ${linked.join(", ")}`);
