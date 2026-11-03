/**
 * The two OpenCode Go usage transports. Pi-free on purpose: the extension and
 * the `scripts/check.ts` diagnostic share exactly one network path.
 */

import { describeFailure, type Credentials } from "./go-usage-core.ts";

const USER_AGENT = "pi-gentle-shell-opencode-go-subscription/1.0";
const REQUEST_TIMEOUT_MS = 15_000;

export class FetchFailure extends Error {
	readonly status: number | undefined;

	constructor(message: string, status?: number) {
		super(message);
		this.status = status;
	}
}

export function resolveOrigin(env: NodeJS.ProcessEnv = process.env): string {
	return (env.OPENCODE_GO_ORIGIN || "https://opencode.ai").replace(/\/+$/, "");
}

async function requestJson(url: string, headers: Record<string, string>): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...headers },
			signal: controller.signal,
			redirect: "manual",
		});
		if (response.status >= 300 && response.status < 400) {
			throw new FetchFailure("redirected", response.status);
		}
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new FetchFailure(describeFailure(response.status, body), response.status);
		}
		return await response.json();
	} catch (error) {
		if (error instanceof FetchFailure) throw error;
		if (error instanceof Error && error.name === "AbortError") throw new FetchFailure("timeout");
		throw new FetchFailure("network error");
	} finally {
		clearTimeout(timer);
	}
}

/** Official endpoint: reports percentages directly, no browser session needed. */
export async function fetchApiKey(apiKey: string, origin = resolveOrigin()): Promise<unknown> {
	return requestJson(`${origin}/zen/go/v1/usage`, { Authorization: `Bearer ${apiKey.trim()}` });
}

/** Legacy console endpoint: micro-cents per meter, needs the browser cookie. */
export async function fetchConsole(workspaceId: string, authCookie: string, origin = resolveOrigin()): Promise<unknown> {
	const cookie = authCookie.trim().replace(/;$/, "");
	return requestJson(`${origin}/console/api/go/status`, {
		Cookie: cookie.includes("=") ? cookie : `__Host-console_session=${cookie}`,
		"x-org-id": workspaceId.trim(),
	});
}

export async function fetchUsage(credentials: Credentials, origin = resolveOrigin()): Promise<unknown> {
	if (credentials.kind === "api") return fetchApiKey(credentials.apiKey, origin);
	if (credentials.kind === "console") {
		return fetchConsole(credentials.workspaceId, credentials.authCookie, origin);
	}
	throw new FetchFailure("no credentials");
}
