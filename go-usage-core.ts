/**
 * Pure core of pi-gentle-shell-opencode-go-subscription.
 *
 * No Pi imports live here, so the whole decision surface — config shape,
 * credential resolution, payload parsing, status formatting — is unit testable
 * with plain Node.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GoStatusConfig {
	version: 1;
	/** Publish the status line into Gentle Shell's Status card. */
	enabled: boolean;
	/** One line with percentages only, or the long form with reset countdowns. */
	compact: boolean;
	refreshSeconds: number;
	/** Optional credentials; env and the OpenCode auth store are tried first. */
	apiKey?: string;
	workspaceId?: string;
	authCookie?: string;
}

export const DEFAULT_CONFIG: Readonly<GoStatusConfig> = {
	version: 1,
	enabled: true,
	compact: true,
	refreshSeconds: 300,
};

export const MIN_REFRESH_SECONDS = 60;
export const MAX_REFRESH_SECONDS = 3600;

export type ConfigStatus = "file" | "defaults" | "malformed";

export interface LoadedConfig {
	status: ConfigStatus;
	config: GoStatusConfig;
	problem?: string;
}

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.GENTLE_PI_AGENT_HOME || env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(resolveAgentDir(env), "opencode-go.json");
}

/** Pi's own credential store, written by `/login`. */
export function piAuthPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(resolveAgentDir(env), "auth.json");
}

/** The OpenCode CLI credential store (shared with `opencode auth`). */
export function opencodeAuthPath(env: NodeJS.ProcessEnv = process.env): string {
	const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return join(env.PI_OPENCODE_AUTH_STORE || join(dataHome, "opencode", "auth.json"));
}

/** The console cookie file written by the OpenCode Go usage plugin. */
export function sharedConsolePath(env: NodeJS.ProcessEnv = process.env): string {
	const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(configHome, "opencode", "opencode-quota", "opencode-go.json");
}

function clampRefresh(seconds: unknown): number {
	const value = typeof seconds === "number" && Number.isFinite(seconds) ? Math.round(seconds) : DEFAULT_CONFIG.refreshSeconds;
	return Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, value));
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseConfig(raw: unknown): { config: GoStatusConfig } | { problem: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { problem: "the file must be a JSON object" };
	}
	const candidate = raw as Record<string, unknown>;
	if (candidate.version !== 1) return { problem: "version must be 1" };

	const apiKey = optionalString(candidate.apiKey);
	const workspaceId = optionalString(candidate.workspaceId);
	const authCookie = optionalString(candidate.authCookie);
	return {
		config: {
			version: 1,
			enabled: candidate.enabled !== false,
			compact: candidate.compact !== false,
			refreshSeconds: clampRefresh(candidate.refreshSeconds),
			...(apiKey ? { apiKey } : {}),
			...(workspaceId ? { workspaceId } : {}),
			...(authCookie ? { authCookie } : {}),
		},
	};
}

export function readConfig(path: string): LoadedConfig {
	if (!existsSync(path)) {
		return { status: "defaults", config: { ...DEFAULT_CONFIG } };
	}
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return {
			status: "malformed",
			config: { ...DEFAULT_CONFIG },
			problem: `cannot read the file (${(error as Error).message})`,
		};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return {
			status: "malformed",
			config: { ...DEFAULT_CONFIG },
			problem: `invalid JSON (${(error as Error).message})`,
		};
	}
	const parsed = parseConfig(raw);
	if ("problem" in parsed) {
		return { status: "malformed", config: { ...DEFAULT_CONFIG }, problem: parsed.problem };
	}
	return { status: "file", config: parsed.config };
}

/**
 * Write through a temp file with 0600: the file may hold an API key or a
 * session cookie, so it is never group/world readable and never half-written.
 */
export function writeConfig(path: string, config: GoStatusConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	const { version: _version, ...rest } = config;
	const body = { version: 1, ...rest };
	for (const key of ["apiKey", "workspaceId", "authCookie"] as const) {
		if (!body[key]) delete body[key];
	}
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(body, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export type Credentials =
	| { kind: "api"; apiKey: string; source: string }
	| { kind: "console"; workspaceId: string; authCookie: string; source: string }
	| { kind: "none"; reason: string };

export interface CredentialInputs {
	env?: Record<string, string | undefined>;
	config?: Partial<GoStatusConfig>;
	/** Parsed `<agent-dir>/auth.json` — what `/login` writes. */
	piAuth?: unknown;
	/** Parsed `~/.local/share/opencode/auth.json`. */
	opencodeAuth?: unknown;
	/** Parsed `~/.config/opencode/opencode-quota/opencode-go.json`. */
	sharedConsole?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
	return optionalString(record(value)?.[key]);
}

/**
 * Resolve credentials, preferring the API-key endpoint because it needs no
 * browser session and reports percentages directly:
 *
 *   1. env  OPENCODE_GO_API_KEY | OPENCODE_API_KEY | OPENCODE_ZEN_API_KEY
 *   2. this extension's config apiKey
 *   3. Pi's own auth store, written by `/login`: `opencode-go`, then `opencode`
 *   4. OpenCode's auth store: the `opencode-go` entry, then `opencode`
 *   5. console cookie + workspace (env, config, shared OpenCode Go file)
 */
export function resolveCredentials(inputs: CredentialInputs = {}): Credentials {
	const env = inputs.env ?? process.env;
	const config = inputs.config ?? {};

	const envKey =
		optionalString(env.OPENCODE_GO_API_KEY) ??
		optionalString(env.OPENCODE_API_KEY) ??
		optionalString(env.OPENCODE_ZEN_API_KEY);
	if (envKey) return { kind: "api", apiKey: envKey, source: "env" };

	if (config.apiKey) return { kind: "api", apiKey: config.apiKey, source: "config" };

	// `/login` inside Pi writes this store, and its opencode-go key is the same
	// subscription key the models use — no separate setup needed.
	const piAuth = record(inputs.piAuth);
	for (const entry of ["opencode-go", "opencode"]) {
		const key = stringAt(piAuth?.[entry], "key");
		if (key) return { kind: "api", apiKey: key, source: `pi login (${entry})` };
	}

	const auth = record(inputs.opencodeAuth);
	for (const entry of ["opencode-go", "opencode"]) {
		const key = stringAt(auth?.[entry], "key");
		if (key) return { kind: "api", apiKey: key, source: `opencode auth (${entry})` };
	}

	const envWorkspace = optionalString(env.OPENCODE_GO_WORKSPACE_ID);
	const envCookie = optionalString(env.OPENCODE_GO_AUTH_COOKIE);
	if (envWorkspace && envCookie) {
		return { kind: "console", workspaceId: envWorkspace, authCookie: envCookie, source: "env" };
	}
	if (config.workspaceId && config.authCookie) {
		return {
			kind: "console",
			workspaceId: config.workspaceId,
			authCookie: config.authCookie,
			source: "config",
		};
	}
	const sharedWorkspace = stringAt(inputs.sharedConsole, "workspaceId");
	const sharedCookie = stringAt(inputs.sharedConsole, "authCookie");
	if (sharedWorkspace && sharedCookie) {
		return {
			kind: "console",
			workspaceId: sharedWorkspace,
			authCookie: sharedCookie,
			source: "opencode-quota",
		};
	}

	return { kind: "none", reason: "no API key or console cookie found" };
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

export type WindowId = "fiveHour" | "week" | "month";

export interface UsageWindow {
	key: WindowId;
	label: "5h" | "wk" | "mo";
	percent: number;
	resetsAt: string | null;
}

export type ParseResult =
	| { ok: true; windows: UsageWindow[]; shape: "api" | "console" }
	| { ok: false; reason: "no-payload" | "shape-changed" };

const SHORT: Record<WindowId, UsageWindow["label"]> = { fiveHour: "5h", week: "wk", month: "mo" };

const API_WINDOWS: ReadonlyArray<{ key: string; id: WindowId }> = [
	{ key: "rolling", id: "fiveHour" },
	{ key: "weekly", id: "week" },
	{ key: "monthly", id: "month" },
];

const CONSOLE_WINDOWS: ReadonlyArray<{ key: string; id: WindowId; fallbackToPeriodEnd?: boolean }> = [
	{ key: "fiveHour", id: "fiveHour" },
	{ key: "week", id: "week" },
	{ key: "month", id: "month", fallbackToPeriodEnd: true },
];

function toNumber(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function clampPercent(value: number): number {
	return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

function isoTimestamp(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Accepts both shapes the service has used:
 *
 *   API key  GET /zen/go/v1/usage
 *            { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }
 *
 *   console  GET /console/api/go/status
 *            { access: { endsAt, meters: { fiveHour|week|month: {
 *                usedMicroCents, limitMicroCents, resetsAt } } } }
 *
 * An empty result is reported as a changed shape, never as a confident zero.
 */
export function parseUsagePayload(payload: unknown): ParseResult {
	if (payload === undefined || payload === null) return { ok: false, reason: "no-payload" };
	const root = record(payload);
	if (!root) return { ok: false, reason: "no-payload" };

	const usage = record(root.usage);
	if (usage) {
		const windows: UsageWindow[] = [];
		for (const { key, id } of API_WINDOWS) {
			const window = record(usage[key]);
			if (!window) continue;
			const percent = toNumber(window.percent);
			if (percent === null) continue;
			windows.push({ key: id, label: SHORT[id], percent: clampPercent(percent), resetsAt: isoTimestamp(window.resetsAt) });
		}
		if (windows.length > 0) return { ok: true, windows, shape: "api" };
	}

	const access = record(root.access);
	const meters = record(access?.meters);
	if (!meters) return { ok: false, reason: "shape-changed" };

	const periodEnd = isoTimestamp(access?.endsAt);
	const windows: UsageWindow[] = [];
	for (const { key, id, fallbackToPeriodEnd } of CONSOLE_WINDOWS) {
		const window = record(meters[key]);
		if (!window) continue;
		const used = toNumber(window.usedMicroCents);
		const limit = toNumber(window.limitMicroCents);
		if (used === null || limit === null) continue;
		const percent = limit > 0 ? (used / limit) * 100 : 0;
		windows.push({
			key: id,
			label: SHORT[id],
			percent: clampPercent(percent),
			resetsAt: isoTimestamp(window.resetsAt) ?? (fallbackToPeriodEnd ? periodEnd : null),
		});
	}
	if (windows.length === 0) return { ok: false, reason: "shape-changed" };
	return { ok: true, windows, shape: "console" };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "1h 12m" / "3d 4h" / "12m" / "now" — the same scale the console shows. */
export function countdown(resetsAt: string | null, now: number = Date.now()): string {
	if (!resetsAt) return "";
	const target = Date.parse(resetsAt);
	if (!Number.isFinite(target)) return "";
	const diffMs = target - now;
	if (diffMs <= 0) return "now";
	const totalMinutes = Math.floor(diffMs / 60_000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

/** The one line that lands under "Integrations" in the sidebar Status card. */
export function formatUsageLine(
	windows: readonly UsageWindow[],
	options: { compact: boolean; now?: number },
): string {
	const parts = windows.map((window) => {
		const percent = `${Math.round(window.percent)}%`;
		if (options.compact) return `${window.label} ${percent}`;
		const reset = countdown(window.resetsAt, options.now);
		return `${window.label} ${percent}${reset ? ` (${reset})` : ""}`;
	});
	return `Go ${parts.join(" · ")}`;
}

export type StatusState =
	| { kind: "disabled" }
	| { kind: "no-credentials" }
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ok"; windows: UsageWindow[]; updatedAt: number };

/**
 * Short enough for a sidebar column; the full sentence belongs in the panel.
 * The hint is only appended when it is actionable.
 */
export function formatStatusText(state: StatusState, options: { compact: boolean; now?: number }): string | undefined {
	switch (state.kind) {
		case "disabled":
			return undefined;
		case "no-credentials":
			return "Go: not connected · /opencode-go";
		case "loading":
			return "Go: loading…";
		case "error":
			return `Go: ${state.message} · /opencode-go`;
		case "ok":
			return formatUsageLine(state.windows, { compact: options.compact, now: options.now });
	}
}

/** Turn a fetch failure into words a person can act on. */
export function describeFailure(status: number, body?: string): string {
	if (status === 401 || status === 403) {
		const code = (() => {
			try {
				const parsed = JSON.parse(body ?? "");
				return typeof parsed?.error?.code === "string" ? parsed.error.code : undefined;
			} catch {
				return undefined;
			}
		})();
		if (code === "api_key_expired") return "API key expired";
		return `auth ${status}`;
	}
	return `HTTP ${status}`;
}
