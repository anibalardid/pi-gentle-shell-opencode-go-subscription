#!/usr/bin/env node
/**
 * Load the extension through Pi's real loader, without starting a session.
 *
 *   node scripts/smoke.mjs [--pi <path-to-pi-coding-agent-package>]
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function resolvePi() {
	const flagIndex = process.argv.indexOf("--pi");
	if (flagIndex !== -1 && process.argv[flagIndex + 1]) return resolve(process.argv[flagIndex + 1]);
	try {
		return dirname(require.resolve("@earendil-works/pi-coding-agent/package.json"));
	} catch {
		const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
		return join(globalRoot, "@earendil-works", "pi-coding-agent");
	}
}

const piPackage = resolvePi();
const loaderUrl = pathToFileURL(join(piPackage, "dist", "core", "extensions", "loader.js")).href;
const { discoverAndLoadExtensions } = await import(loaderUrl);

const agentDir = mkdtempSync(join(tmpdir(), "ocgo-smoke-"));
mkdirSync(join(agentDir, "extensions"), { recursive: true });
symlinkSync(repo, join(agentDir, "extensions", "pi-gentle-shell-opencode-go-subscription"), "dir");

process.env.PI_CODING_AGENT_DIR = agentDir;

try {
	const result = await discoverAndLoadExtensions([], repo, agentDir);
	if (result.errors.length > 0) {
		for (const error of result.errors) console.error(`ERROR ${error.path}: ${error.error}`);
		process.exitCode = 1;
	} else {
		const extension = result.extensions.find((entry) => entry.path.includes("opencode-go-subscription"));
		if (!extension) {
			console.error("ERROR: the extension was not discovered");
			process.exitCode = 1;
		} else {
			const commands = [...extension.commands.keys()];
			console.log(`loaded: ${extension.path}`);
			console.log(`commands: ${commands.join(", ") || "(none)"}`);
			if (!commands.includes("opencode-go")) {
				console.error("ERROR: /opencode-go was not registered");
				process.exitCode = 1;
			}
		}
	}
	if (result.warnings?.length) {
		for (const warning of result.warnings) console.warn(`WARN ${warning.path}: ${warning.warning}`);
	}
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
