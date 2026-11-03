/**
 * pi-gentle-shell-opencode-go-subscription
 *
 * Publishes your OpenCode Go subscription usage into Gentle Shell's sidebar
 * Status card (the "Integrations" group), refreshes it on a timer, and lets you
 * turn it on or off with `/opencode-go`.
 *
 * Credentials never live in this repository. They are resolved, in order, from
 * the environment, this extension's own config file next to Pi's agent dir, or
 * OpenCode's credential store — so an `opencode auth login` is usually enough.
 */

import { readFileSync } from "node:fs";
import { parseKey } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	configPath,
	formatStatusText,
	opencodeAuthPath,
	parseUsagePayload,
	piAuthPath,
	readConfig,
	resolveCredentials,
	sharedConsolePath,
	writeConfig,
	type Credentials,
	type GoStatusConfig,
	type StatusState,
} from "./go-usage-core.ts";
import { FetchFailure, fetchUsage } from "./go-usage-fetch.ts";

const STATUS_KEY = "opencode-go";
const REFRESH_CHOICES = [60, 120, 300, 600] as const;

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

interface ThemeLike {
	fg(role: string, text: string): string;
	bold(text: string): string;
}

type PanelAction = "close" | "auth";

interface PanelRow {
	label: string;
	value: () => string;
	/** Present when Enter does something inside the panel. */
	activate?: () => void | Promise<void>;
	/** Present when Enter must close the panel so the command can open a dialog. */
	opens?: Exclude<PanelAction, "close">;
}

const PANEL_HINT = "↑/↓ move · Enter change · r refresh · Esc close";

function truncate(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}

class GoPanel {
	private index = 0;
	private readonly rows: readonly PanelRow[];
	private readonly note: string | undefined;
	private readonly theme: ThemeLike;
	private readonly requestRender: () => void;
	private readonly done: (action: PanelAction) => void;

	constructor(
		rows: readonly PanelRow[],
		note: string | undefined,
		theme: ThemeLike,
		requestRender: () => void,
		done: (action: PanelAction) => void,
	) {
		this.rows = rows;
		this.note = note;
		this.theme = theme;
		this.requestRender = requestRender;
		this.done = done;
	}

	render(width: number): string[] {
		const lines = [this.theme.fg("accent", this.theme.bold("✿ OpenCode Go"))];
		if (this.note) lines.push(truncate(this.theme.fg("warning", this.note), width));
		lines.push("");

		const labelWidth = Math.max(...this.rows.map((row) => row.label.length), 6);
		for (const [index, row] of this.rows.entries()) {
			const selected = index === this.index;
			const pointer = selected ? this.theme.fg("accent", "› ") : "  ";
			const label = this.theme.fg(selected ? "accent" : "text", row.label.padEnd(labelWidth));
			const value = this.theme.fg(selected ? "accent" : "muted", row.value());
			lines.push(truncate(`${pointer}${label}  ${value}`, width));
		}

		lines.push("");
		lines.push(truncate(this.theme.fg("muted", PANEL_HINT), width));
		return lines;
	}

	handleInput(data: string): void {
		const pressed = parseKey(data);
		if (!pressed) return;
		if (pressed === "up" || pressed === "k") {
			this.index = (this.index - 1 + this.rows.length) % this.rows.length;
			return;
		}
		if (pressed === "down" || pressed === "j") {
			this.index = (this.index + 1) % this.rows.length;
			return;
		}
		if (pressed === "escape" || pressed === "q") {
			this.done("close");
			return;
		}
		if (pressed === "enter") {
			const row = this.rows[this.index];
			if (!row) return;
			if (row.opens) {
				this.done(row.opens);
				return;
			}
			void Promise.resolve(row.activate?.()).finally(() => this.requestRender());
		}
	}

	invalidate(): void {}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function opencodeGoStatus(pi: ExtensionAPI): void {
	const env = process.env;
	const path = configPath(env);
	const loaded = readConfig(path);

	let config: GoStatusConfig = { ...loaded.config };
	let configProblem = loaded.problem;
	let state: StatusState = { kind: config.enabled ? "loading" : "disabled" };
	let lastUpdatedAt: number | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let context: ExtensionContext | undefined;
	let refreshing = false;
	let cachedCredentials: Credentials | undefined;

	const credentials = (): Credentials => {
		cachedCredentials ??= resolveCredentials({
			env,
			config,
			piAuth: readJson(piAuthPath(env)),
			opencodeAuth: readJson(opencodeAuthPath(env)),
			sharedConsole: readJson(sharedConsolePath(env)),
		});
		return cachedCredentials;
	};
	const invalidateCredentials = (): void => {
		cachedCredentials = undefined;
	};

	const publish = (): void => {
		try {
			context?.ui.setStatus(STATUS_KEY, formatStatusText(state, { compact: config.compact }));
		} catch {
			// Status is cosmetic: a lost context must never break a refresh.
		}
	};

	const refresh = async (): Promise<void> => {
		if (!config.enabled) {
			state = { kind: "disabled" };
			publish();
			return;
		}
		if (refreshing) return;
		refreshing = true;
		try {
			const resolved = credentials();
			if (resolved.kind === "none") {
				state = { kind: "no-credentials" };
				return;
			}
			if (state.kind !== "ok") {
				state = { kind: "loading" };
				publish();
			}
			let payload: unknown;
			try {
				payload = await fetchUsage(resolved);
			} catch (error) {
				state = { kind: "error", message: error instanceof FetchFailure ? error.message : "network error" };
				return;
			}
			const parsed = parseUsagePayload(payload);
			if (!parsed.ok) {
				state = {
					kind: "error",
					message: parsed.reason === "shape-changed" ? "unexpected response" : "empty response",
				};
				return;
			}
			lastUpdatedAt = Date.now();
			state = { kind: "ok", windows: parsed.windows, updatedAt: lastUpdatedAt };
		} finally {
			refreshing = false;
			publish();
		}
	};

	const stopTimer = (): void => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	const startTimer = (): void => {
		stopTimer();
		if (!config.enabled) return;
		timer = setInterval(() => void refresh(), config.refreshSeconds * 1000);
		// A timer alone must not keep the process alive.
		(timer as { unref?: () => void }).unref?.();
	};

	/** Returns whether the file was actually written. */
	const applyConfig = (next: GoStatusConfig): boolean => {
		config = next;
		invalidateCredentials();
		if (configProblem) return false; // Never overwrite a file we could not parse.
		try {
			writeConfig(path, config);
			return true;
		} catch (error) {
			context?.ui.notify(`opencode-go: cannot save config (${(error as Error).message})`, "error");
			return false;
		}
	};

	const credentialLabel = (): string => {
		if (!config.enabled) return "off";
		const resolved = credentials();
		if (resolved.kind === "api") return `api key · ${resolved.source}`;
		if (resolved.kind === "console") return `console cookie · ${resolved.source}`;
		return "none — set OPENCODE_GO_API_KEY";
	};

	const detail = (): string => {
		if (state.kind === "ok") return formatStatusText(state, { compact: false });
		return formatStatusText(state, { compact: config.compact }) ?? "off";
	};

	const openPanel = async (ctx: ExtensionCommandContext): Promise<PanelAction> => {
		let changed = false;
		invalidateCredentials();

		const rows: PanelRow[] = [
			{
				label: "enabled",
				value: () => (config.enabled ? "on" : "off"),
				activate: () => {
					config = { ...config, enabled: !config.enabled };
					changed = true;
					if (config.enabled) {
						state = { kind: "loading" };
						void refresh();
						startTimer();
					} else {
						state = { kind: "disabled" };
						stopTimer();
						publish();
					}
				},
			},
			{
				label: "compact",
				value: () => (config.compact ? "on" : "off"),
				activate: () => {
					config = { ...config, compact: !config.compact };
					changed = true;
					publish();
				},
			},
			{
				label: "refresh",
				value: () => `${config.refreshSeconds}s`,
				activate: () => {
					const index = REFRESH_CHOICES.indexOf(config.refreshSeconds as (typeof REFRESH_CHOICES)[number]);
					const next = REFRESH_CHOICES[(index + 1) % REFRESH_CHOICES.length]!;
					config = { ...config, refreshSeconds: next };
					changed = true;
					if (config.enabled) startTimer();
				},
			},
			{
				label: "refresh now",
				value: () => (refreshing ? "fetching…" : "Enter"),
				activate: async () => {
					await refresh();
				},
			},
			{ label: "auth", value: credentialLabel },
			{ label: "set api key", value: () => "Enter", opens: "auth" },
			{
				label: "updated",
				value: () => (lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleTimeString() : "never"),
			},
			{ label: "status", value: detail },
		];

		const action = await ctx.ui.custom<PanelAction>(
			(tui, theme, _keybindings, done) =>
				new GoPanel(
					rows,
					configProblem,
					theme as unknown as ThemeLike,
					() => tui.requestRender(),
					done,
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 56, maxHeight: "80%" } },
		);

		if (changed) {
			applyConfig(config);
			publish();
		}
		return action;
	};

	// The panel closes before this dialog opens: Pi cannot nest a dialog inside a
	// custom component, and the key belongs in the config file, not in the session.
	const askForApiKey = async (ctx: ExtensionCommandContext): Promise<void> => {
		const answer = await ctx.ui.input(
			"OpenCode Go API key (empty clears the saved key)",
			"oc_sk_…",
		);
		if (answer === undefined) return;

		const key = answer.trim();
		config = { ...config, apiKey: key || undefined };
		const saved = applyConfig(config);
		invalidateCredentials();

		if (!key) {
			await refresh();
			ctx.ui.notify("opencode-go: saved key cleared", "info");
			return;
		}

		await refresh();
		const resolved = credentials();
		if (!saved) {
			ctx.ui.notify("opencode-go: key applied for this session only; the config file is unreadable", "warning");
			return;
		}
		if (resolved.kind !== "api") {
			ctx.ui.notify("opencode-go: key saved, but another source is not taking it", "warning");
			return;
		}
		ctx.ui.notify(`opencode-go: key saved (${resolved.source}) · ${detail()}`, "info");
	};

	pi.on("session_start", async (_event, ctx) => {
		context = ctx;
		if (configProblem) {
			ctx.ui.notify(`opencode-go: config unreadable (${configProblem}); using defaults`, "warning");
		}
		publish();
		if (!config.enabled) return;
		void refresh();
		startTimer();
	});

	pi.on("session_shutdown", async () => {
		stopTimer();
		try {
			context?.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// Nothing to clear when the UI is already gone.
		}
		context = undefined;
	});

	pi.registerCommand("opencode-go", {
		description: "OpenCode Go usage in the sidebar Status card: on/off, refresh, auth source",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on" || action === "off") {
				config = { ...config, enabled: action === "on" };
				applyConfig(config);
				if (config.enabled) {
					state = { kind: "loading" };
					await refresh();
					startTimer();
				} else {
					state = { kind: "disabled" };
					stopTimer();
					publish();
				}
				ctx.ui.notify(`opencode-go: ${action === "on" ? "enabled" : "disabled"}`, "info");
				return;
			}
			if (action === "refresh") {
				await refresh();
				ctx.ui.notify(`opencode-go: ${detail()}`, "info");
				return;
			}
			if (action === "reset") {
				config = { ...DEFAULT_CONFIG };
				configProblem = undefined;
				applyConfig(config);
				state = { kind: "loading" };
				await refresh();
				startTimer();
				ctx.ui.notify("opencode-go: config recreated with defaults", "info");
				return;
			}
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify(`opencode-go: ${detail()} · config ${path}`, "info");
				return;
			}
			context = ctx;
			for (;;) {
				const action = await openPanel(ctx);
				if (action === "close") break;
				await askForApiKey(ctx);
			}
		},
	});
}
