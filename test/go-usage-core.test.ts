import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	DEFAULT_CONFIG,
	configPath,
	countdown,
	describeFailure,
	formatStatusText,
	formatUsageLine,
	opencodeAuthPath,
	parseConfig,
	parseUsagePayload,
	piAuthPath,
	readConfig,
	resolveAgentDir,
	resolveCredentials,
	sharedConsolePath,
	writeConfig,
	type UsageWindow,
} from "../go-usage-core.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "ocgo-"));
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test("parseConfig fills defaults and clamps the refresh window", () => {
	assert.deepEqual(parseConfig({ version: 1 }), {
		config: { ...DEFAULT_CONFIG },
	});

	const fast = parseConfig({ version: 1, refreshSeconds: 5 });
	assert.equal("config" in fast ? fast.config.refreshSeconds : -1, 60);

	const slow = parseConfig({ version: 1, refreshSeconds: 99_999 });
	assert.equal("config" in slow ? slow.config.refreshSeconds : -1, 3600);
});

test("parseConfig refuses a wrong version or a non-object", () => {
	assert.match((parseConfig({ version: 2 }) as { problem: string }).problem, /version/);
	assert.match((parseConfig(null) as { problem: string }).problem, /JSON object/);
	assert.match((parseConfig([]) as { problem: string }).problem, /JSON object/);
});

test("parseConfig keeps credentials only when they are non-empty strings", () => {
	const parsed = parseConfig({
		version: 1,
		apiKey: "  sk-abc  ",
		workspaceId: "   ",
		authCookie: "st_1",
	});
	assert.ok("config" in parsed);
	assert.equal(parsed.config.apiKey, "sk-abc");
	assert.equal(parsed.config.workspaceId, undefined);
	assert.equal(parsed.config.authCookie, "st_1");
});

test("readConfig treats a missing file as defaults and a broken one as malformed", () => {
	const dir = tempDir();
	try {
		const missing = readConfig(join(dir, "opencode-go.json"));
		assert.equal(missing.status, "defaults");
		assert.deepEqual(missing.config, { ...DEFAULT_CONFIG });

		const path = join(dir, "opencode-go.json");
		writeFileSync(path, "{ nope");
		const broken = readConfig(path);
		assert.equal(broken.status, "malformed");
		assert.match(broken.problem ?? "", /invalid JSON/);
		assert.deepEqual(broken.config, { ...DEFAULT_CONFIG });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writeConfig is 0600, round-trips, and drops empty credentials", () => {
	const dir = tempDir();
	const path = join(dir, "nested", "opencode-go.json");
	try {
		writeConfig(path, { version: 1, enabled: false, compact: false, refreshSeconds: 120, apiKey: "sk-x" });
		assert.equal(statSync(path).mode & 0o777, 0o600);

		const parsed = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(parsed.version, 1);
		assert.equal(parsed.enabled, false);
		assert.equal(parsed.apiKey, "sk-x");
		assert.equal("workspaceId" in parsed, false);
		assert.equal("authCookie" in parsed, false);

		writeConfig(path, { version: 1, enabled: true, compact: true, refreshSeconds: 300, apiKey: "" });
		assert.equal("apiKey" in JSON.parse(readFileSync(path, "utf8")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("paths follow the runtime environment", () => {
	assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/agent" } as NodeJS.ProcessEnv), "/tmp/agent");
	assert.equal(resolveAgentDir({ GENTLE_PI_AGENT_HOME: "/tmp/g" } as NodeJS.ProcessEnv), "/tmp/g");
	assert.match(configPath({ PI_CODING_AGENT_DIR: "/tmp/agent" } as NodeJS.ProcessEnv), /\/tmp\/agent\/opencode-go\.json$/);
	assert.match(
		opencodeAuthPath({ XDG_DATA_HOME: "/tmp/data" } as NodeJS.ProcessEnv),
		/\/tmp\/data\/opencode\/auth\.json$/,
	);
	assert.match(
		sharedConsolePath({ XDG_CONFIG_HOME: "/tmp/cfg" } as NodeJS.ProcessEnv),
		/\/tmp\/cfg\/opencode\/opencode-quota\/opencode-go\.json$/,
	);
	assert.match(piAuthPath({ PI_CODING_AGENT_DIR: "/tmp/agent" } as NodeJS.ProcessEnv), /\/tmp\/agent\/auth\.json$/);
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

test("an API key wins over a console cookie, env wins over config", () => {
	const env = { OPENCODE_GO_API_KEY: "sk-env" };
	const config = { apiKey: "sk-config", workspaceId: "wrk_1", authCookie: "st_1" };
	const resolved = resolveCredentials({ env, config });
	assert.deepEqual(resolved, { kind: "api", apiKey: "sk-env", source: "env" });

	const fromConfig = resolveCredentials({ env: {}, config });
	assert.equal(fromConfig.kind, "api");
	assert.equal("apiKey" in fromConfig ? fromConfig.apiKey : "", "sk-config");
});

test("the key written by /login is used before the OpenCode CLI store", () => {
	const piAuth = { "opencode-go": { type: "api_key", key: "oc_sk_login" } };
	const opencodeAuth = { "opencode-go": { type: "api", key: "sk-cli" } };
	const resolved = resolveCredentials({ env: {}, config: {}, piAuth, opencodeAuth });
	assert.deepEqual(resolved, { kind: "api", apiKey: "oc_sk_login", source: "pi login (opencode-go)" });

	const fromCli = resolveCredentials({ env: {}, config: {}, piAuth: {}, opencodeAuth });
	assert.equal(fromCli.kind, "api");
	assert.equal("source" in fromCli ? fromCli.source : "", "opencode auth (opencode-go)");
});

test("an explicit config key beats both auth stores", () => {
	const resolved = resolveCredentials({
		env: {},
		config: { apiKey: "sk-config" },
		piAuth: { "opencode-go": { key: "oc_sk_login" } },
	});
	assert.equal(resolved.kind, "api");
	assert.equal("source" in resolved ? resolved.source : "", "config");
});

test("the OpenCode auth store is used when nothing else provides a key", () => {
	const auth = { "opencode-go": { type: "api", key: "sk-go" }, opencode: { type: "api", key: "sk-main" } };
	const resolved = resolveCredentials({ env: {}, config: {}, opencodeAuth: auth });
	assert.deepEqual(resolved, { kind: "api", apiKey: "sk-go", source: "opencode auth (opencode-go)" });

	const fallback = resolveCredentials({ env: {}, config: {}, opencodeAuth: { opencode: { key: "sk-main" } } });
	assert.equal(fallback.kind, "api");
	assert.equal("source" in fallback ? fallback.source : "", "opencode auth (opencode)");
});

test("console credentials are used only when no key exists, and need both halves", () => {
	const sharedConsole = { workspaceId: "wrk_shared", authCookie: "st_shared" };
	const resolved = resolveCredentials({ env: {}, config: {}, opencodeAuth: {}, sharedConsole });
	assert.deepEqual(resolved, { kind: "console", workspaceId: "wrk_shared", authCookie: "st_shared", source: "opencode-quota" });

	const half = resolveCredentials({ env: {}, config: {}, sharedConsole: { workspaceId: "wrk_only" } });
	assert.equal(half.kind, "none");
	assert.match(half.kind === "none" ? half.reason : "", /no API key/);
});

test("nothing configured resolves to a reason, not a crash", () => {
	const resolved = resolveCredentials({ env: {}, config: {}, opencodeAuth: undefined });
	assert.equal(resolved.kind, "none");
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("parses the API-key shape with direct percentages", () => {
	const payload = {
		usage: {
			rolling: { status: "ok", percent: 62.4, resetsAt: "2026-11-02T18:00:00.000Z" },
			weekly: { status: "ok", percent: 31, resetsAt: "2026-11-05T00:00:00.000Z" },
			monthly: { status: "ok", percent: 44, resetsAt: "2026-11-20T00:00:00.000Z" },
		},
	};
	const parsed = parseUsagePayload(payload);
	assert.ok(parsed.ok);
	assert.equal(parsed.shape, "api");
	assert.deepEqual(
		parsed.windows.map((window) => [window.label, window.percent]),
		[
			["5h", 62.4],
			["wk", 31],
			["mo", 44],
		],
	);
});

test("parses the console shape from micro-cents and falls back to the period end", () => {
	const payload = {
		access: {
			endsAt: "2026-11-20T00:00:00.000Z",
			meters: {
				fiveHour: { usedMicroCents: "500000000", limitMicroCents: "1000000000", resetsAt: "2026-11-02T18:00:00.000Z" },
				week: { usedMicroCents: "250", limitMicroCents: "1000" },
				month: { usedMicroCents: "44", limitMicroCents: "100" },
			},
		},
	};
	const parsed = parseUsagePayload(payload);
	assert.ok(parsed.ok);
	assert.equal(parsed.shape, "console");
	assert.equal(parsed.windows[0]?.percent, 50);
	assert.equal(parsed.windows[1]?.percent, 25);
	assert.equal(parsed.windows[1]?.resetsAt, null);
	assert.equal(parsed.windows[2]?.resetsAt, "2026-11-20T00:00:00.000Z");
});

test("an empty or reshaped payload is reported, never a confident zero", () => {
	assert.deepEqual(parseUsagePayload(null), { ok: false, reason: "no-payload" });
	assert.deepEqual(parseUsagePayload({ usage: {} }), { ok: false, reason: "shape-changed" });
	assert.deepEqual(parseUsagePayload({ access: { meters: {} } }), { ok: false, reason: "shape-changed" });
});

test("percentages are clamped to 0..100", () => {
	const parsed = parseUsagePayload({ usage: { rolling: { percent: 250 } } });
	assert.ok(parsed.ok);
	assert.equal(parsed.windows[0]?.percent, 100);

	const negative = parseUsagePayload({ usage: { rolling: { percent: -5 } } });
	assert.ok(negative.ok);
	assert.equal(negative.windows[0]?.percent, 0);
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const windows: UsageWindow[] = [
	{ key: "fiveHour", label: "5h", percent: 62, resetsAt: "2026-11-02T18:00:00.000Z" },
	{ key: "week", label: "wk", percent: 31, resetsAt: "2026-11-05T00:00:00.000Z" },
	{ key: "month", label: "mo", percent: 44, resetsAt: null },
];

test("the compact line fits a sidebar column", () => {
	assert.equal(formatUsageLine(windows, { compact: true }), "Go 5h 62% · wk 31% · mo 44%");
});

test("the full line adds reset countdowns and tolerates a missing one", () => {
	const now = Date.parse("2026-11-02T16:48:00.000Z");
	assert.equal(
		formatUsageLine(windows, { compact: false, now }),
		"Go 5h 62% (1h 12m) · wk 31% (2d 7h) · mo 44%",
	);
});

test("countdown formats days, hours and minutes", () => {
	const now = Date.parse("2026-11-02T00:00:00.000Z");
	assert.equal(countdown("2026-11-02T01:12:00.000Z", now), "1h 12m");
	assert.equal(countdown("2026-11-05T04:00:00.000Z", now), "3d 4h");
	assert.equal(countdown("2026-11-02T00:12:00.000Z", now), "12m");
	assert.equal(countdown("2026-11-01T00:00:00.000Z", now), "now");
	assert.equal(countdown(null, now), "");
	assert.equal(countdown("not a date", now), "");
});

test("status text says what to do in each state", () => {
	assert.equal(formatStatusText({ kind: "disabled" }, { compact: true }), undefined);
	assert.equal(formatStatusText({ kind: "loading" }, { compact: true }), "Go: loading…");
	assert.equal(
		formatStatusText({ kind: "no-credentials" }, { compact: true }),
		"Go: not connected · /opencode-go",
	);
	assert.equal(
		formatStatusText({ kind: "error", message: "API key expired" }, { compact: true }),
		"Go: API key expired · /opencode-go",
	);
	assert.equal(
		formatStatusText({ kind: "ok", windows, updatedAt: 0 }, { compact: true }),
		"Go 5h 62% · wk 31% · mo 44%",
	);
});

test("failure messages are short but name the real problem", () => {
	assert.equal(describeFailure(401, JSON.stringify({ error: { code: "api_key_expired" } })), "API key expired");
	assert.equal(describeFailure(401, ""), "auth 401");
	assert.equal(describeFailure(403), "auth 403");
	assert.equal(describeFailure(500), "HTTP 500");
});
