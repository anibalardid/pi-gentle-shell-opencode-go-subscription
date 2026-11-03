#!/usr/bin/env node
/**
 * Live diagnostic: resolve the credentials the extension would use, hit the
 * real endpoint, and print what the sidebar line would say.
 *
 *   node --experimental-strip-types scripts/check.ts
 *
 * It never prints the key or the cookie — only where the credential came from
 * and what the service answered.
 */
import { readFileSync } from "node:fs";

import {
	formatStatusText,
	opencodeAuthPath,
	parseUsagePayload,
	piAuthPath,
	resolveCredentials,
	sharedConsolePath,
	type StatusState,
} from "../go-usage-core.ts";
import { FetchFailure, fetchUsage } from "../go-usage-fetch.ts";

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

const credentials = resolveCredentials({
	env: process.env,
	config: {},
	piAuth: readJson(piAuthPath()),
	opencodeAuth: readJson(opencodeAuthPath()),
	sharedConsole: readJson(sharedConsolePath()),
});

console.log(`auth: ${credentials.kind === "none" ? credentials.reason : `${credentials.kind} · ${credentials.source}`}`);

if (credentials.kind === "none") {
	console.log("status: Go: not connected · /opencode-go");
	process.exitCode = 1;
} else {
	try {
		const payload = await fetchUsage(credentials);
		const parsed = parseUsagePayload(payload);
		if (!parsed.ok) {
			const state: StatusState = { kind: "error", message: parsed.reason };
			console.log(`shape: ${parsed.reason}`);
			console.log(`status: ${formatStatusText(state, { compact: true })}`);
			process.exitCode = 1;
		} else {
			console.log(`shape: ${parsed.shape}`);
			const state: StatusState = { kind: "ok", windows: parsed.windows, updatedAt: Date.now() };
			console.log(`status: ${formatStatusText(state, { compact: true })}`);
			console.log(`detail: ${formatStatusText(state, { compact: false })}`);
		}
	} catch (error) {
		const message = error instanceof FetchFailure ? error.message : "network error";
		const state: StatusState = { kind: "error", message };
		console.log(`status: ${formatStatusText(state, { compact: true })}`);
		process.exitCode = 1;
	}
}
