/** Web search extension resource. Enable or disable it with `pi config`. */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import type { BackendConfig, SearchConfig, SearchResultWithBackend } from "./types.js";
import { getAgentDir, clearCooldowns } from "./utils.js";
import { getKeySource } from "./credentials.js";
import { config, refreshConfig, getActiveBackends, recordLatency, latencyMap } from "./config.js";
import { BACKEND_DEFS, runBackendDetailed } from "./backends/registry.js";
import { selectBackendsForFallback, reciprocalRankFusion } from "./dispatch.js";
import { formatResults, formatCombinedResults, formatResultsCompact, formatCombinedResultsCompact } from "./formatters.js";

export default function (pi: ExtensionAPI) {
	refreshConfig(process.cwd(), true);

	// -----------------------------------------------------------------------
	// Tool: web_search
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using one of several backend search engines. " +
			"Supports DuckDuckGo (free, no key), " +
			"Marginalia Search (free, shared public key), Serper, Tavily, Exa, Brave, " +
			"LangSearch, Firecrawl, WebSearchAPI, Perplexity Sonar, and SearXNG (most need API keys). " +
			"The best available backend is used automatically. " +
			"Use combine=true to query all enabled backends in parallel for broader coverage. " +
			"Use for fact-finding, research, documentation lookups, and current events.",
		promptSnippet: "Search the web (supports multiple search backends)",
		promptGuidelines: [
			"Use web_search when you need up-to-date information, facts, or documentation from the web",
			"Auto mode tries enabled backends in order (DuckDuckGo is the free fallback)",
			"Set combine=true to query ALL backends in parallel and merge/deduplicate results",
			"Configure additional backends in .pi/search.json for better quality results",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Search query (natural language works best)",
			}),
			numResults: Type.Optional(
				Type.Number({
					description: "Number of results (1-20, default 10)",
					default: 10,
				}),
			),
			backend: Type.Optional(
				StringEnum(["duckduckgo", "jina", "marginalia", "serper", "tavily", "exa", "exa_mcp",
					"brave", "brave-llm", "langsearch", "firecrawl", "websearchapi", "perplexity",
					"searxng", "linkup", "youcom", "fastcrw", "sofya", "auto"] as const, {
					description:
						"Backend to use. 'auto' picks the best configured backend (default)",
				}),
			),
			combine: Type.Optional(
				Type.Boolean({
					description:
						"When true, queries ALL enabled backends in parallel and merges/deduplicates results. " +
						"Default is false (fallback mode: uses first successful backend only). " +
						"Ignored when a specific backend is requested (backend != 'auto').",
					default: false,
				}),
			),
			compact: Type.Optional(
				Type.Boolean({
					description:
						"When true, returns compact single-line results (title + URL). " +
						"Default is false (verbose markdown with snippets).",
					default: false,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			refreshConfig(ctx.cwd);
			const numResults = Math.max(1, Math.min(params.numResults ?? 10, 20));
			const requestedBackend = params.backend || "auto";
			const combine = params.combine ?? false;
			const compact = params.compact ?? false;
			// If config has combine:true, force combine mode regardless of LLM choice
			const forceCombine = config.combine === true;
			const effectiveCombine = forceCombine || combine;

			if (requestedBackend !== "auto") {
				// Specific backend requested — try it directly
				const response = await runBackendDetailed(requestedBackend, params.query, numResults, signal);
				const { results, warning } = response;
				return {
					content: [{ type: "text", text: compact ? formatResultsCompact(results, warning) : formatResults(params.query, requestedBackend, results, warning) }],
					details: { backend: requestedBackend, resultCount: results.length, warning },
				};
			}

			// Auto mode
			const activeBackends = getActiveBackends();

			if (effectiveCombine) {
				// Combine mode: query all enabled backends in parallel
				const resultsPerBackend = await Promise.all(
					activeBackends.map(async (backend) => {
						try {
							const response = await runBackendDetailed(
								backend,
								params.query,
								Math.ceil(numResults / activeBackends.length),
								signal,
							);
							return {
								backend,
								results: response.results.map((r) => ({ ...r, backend })) as SearchResultWithBackend[],
								success: true,
								warning: response.warning,
							};
						} catch (err) {
							return {
								backend,
								results: [] as SearchResultWithBackend[],
								success: false,
								error: (err as Error).message,
								warning: undefined,
							};
						}
					}),
				);

				// Build backend stats map
				const backendStats = new Map<
					string,
					{ success: boolean; count: number; error?: string; warning?: string }
				>();

				for (const { backend, results, success, error, warning } of resultsPerBackend) {
					backendStats.set(backend, {
						success,
						count: results.length,
						error,
						warning,
					});
				}

				// Merge and re-rank using Reciprocal Rank Fusion
				const successfulBackends = resultsPerBackend
					.filter(r => r.success && r.results.length > 0)
					.map(r => ({ backend: r.backend, results: r.results }));

				const combined = successfulBackends.length > 0
					? reciprocalRankFusion(successfulBackends, numResults)
					: [];

				const warnings = resultsPerBackend
					.filter(r => r.warning)
					.map(r => `${r.backend}: ${r.warning}`);

				return {
					content: [
						{
							type: "text",
							text: compact
								? formatCombinedResultsCompact(combined, warnings)
							: formatCombinedResults(params.query, combined, backendStats, BACKEND_DEFS),
						},
					],
					details: {
						backend: "combined",
						resultCount: combined.length,
						backendStats: Object.fromEntries(backendStats),
					},
				};
			} else {
				// Fallback mode: select backends using configured strategy
				const orderedBackends = selectBackendsForFallback(
					config.selectionStrategy ?? "sequential",
					activeBackends,
				);
				const errors: string[] = [];
				for (const backend of orderedBackends) {
					const t0 = Date.now();
					try {
						const response = await runBackendDetailed(backend, params.query, numResults, signal);
						const { results, warning } = response;
						recordLatency(backend, Date.now() - t0);
						const formatted = compact
							? formatResultsCompact(results, warning)
							: formatResults(params.query, backend, results, warning);
						return {
							content: [
								{
									type: "text",
									text: errors.length > 0
										? `${errors.join("; ")}\n\n${formatted}`
										: formatted,
								},
							],
							details: {
								backend: errors.length > 0 ? `${backend} (fallback)` : backend,
								resultCount: results.length,
								errors: errors.length > 0 ? errors : undefined,
								warning,
							},
						};
					} catch (err) {
						errors.push(`${backend}: ${(err as Error).message}`);
					}
				}

				throw new Error(`All backends failed: ${errors.join("; ")}`);
			}
		},
		renderResult(result, { expanded }, theme, context) {
			const details = result.details as { backend?: unknown; resultCount?: unknown; errors?: unknown; warning?: unknown } | undefined;
			const text = result.content[0];
			const raw = text?.type === "text" ? text.text : "";
			const hint = keyHint("app.tools.expand", "expand");
			const isError = context?.isError === true;

			if (isError) {
				if (!expanded) {
					return new Text(
						theme.fg("error", "✗ Search failed") +
						theme.fg("dim", ` (${hint})`),
						0, 0,
					);
				}
				return new Text(theme.fg("error", raw || "Search failed"), 0, 0);
			}

			const backend = typeof details?.backend === "string" ? details.backend : undefined;
			const resultCount = typeof details?.resultCount === "number" ? details.resultCount : undefined;
			const errors = Array.isArray(details?.errors) ? details.errors.map(String) : [];
			const warning = typeof details?.warning === "string" ? details.warning : undefined;

			if (!backend || resultCount === undefined) return new Text(raw, 0, 0);

			const errorMark = errors.length
				? theme.fg("warning", " [some backends failed]")
				: "";
			const warningMark = warning ? theme.fg("warning", " [warning]") : "";

			if (!expanded) {
				return new Text(
					theme.fg("success", `✓ ${resultCount} result${resultCount === 1 ? "" : "s"}`) +
					theme.fg("muted", ` via ${backend}`) +
					errorMark +
					warningMark +
					theme.fg("dim", ` (${hint})`),
					0, 0,
				);
			}

			// Expanded: render compact list instead of full markdown
			const lines: string[] = [];
			if (errors.length) {
				for (const err of errors) {
					lines.push(theme.fg("warning", `⚠ ${err}`));
				}
				lines.push("");
			}
			if (warning) {
				lines.push(theme.fg("warning", `⚠ ${warning}`));
				lines.push("");
			}

			// Extract results from raw for compact listing
			const resultPattern = /### \d+\.\s+(.+?)\n\s*URL:\s+(\S+)/g;
			let match;
			let idx = 0;
			while ((match = resultPattern.exec(raw)) !== null) {
				idx++;
				const title = match[1].replace(/\*Source:.*?\*\n\s*/, "").trim();
				const url = match[2];
				lines.push(`${idx}. ${theme.fg("accent", title.slice(0, 60))}`);
				lines.push(`   ${theme.fg("muted", url)}`);
			}

			// Fallback: show raw if parsing failed
			if (idx === 0) return new Text(raw, 0, 0);

			lines.push("");
			lines.push(theme.fg("dim", `(${hint} to collapse)`));
			return new Text(lines.join("\n"), 0, 0);
		},
	});


	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------

	pi.registerCommand("search-setup", {
		description: "Configure search backends interactively",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/search-setup requires interactive mode", "error");
				return;
			}

			const backends = Object.values(BACKEND_DEFS)
				.filter(d => d.setupLabel !== null)
				.map(d => d.setupLabel!);

			const backendKey: Record<string, string> = Object.fromEntries(
				Object.entries(BACKEND_DEFS)
					.filter(([_, d]) => d.setupLabel !== null)
					.map(([k, d]) => [d.setupLabel!, k])
			);

			const option = await ctx.ui.select("Which backend do you want to configure?", [
				...backends,
				"✅ Done — save and exit",
			]);

			if (!option || option.startsWith("✅ Done")) {
				ctx.ui.notify("Search setup complete.", "info");
				return;
			}

			const backend = backendKey[option];
			const def = BACKEND_DEFS[backend];
			const label = option;

			// Free backends (needsKey: false) can be enabled without API key
			if (!def.needsKey) {
				const enable = await ctx.ui.select(
					`${label} is free and needs no API key. Enable it?`,
					["Yes, enable it", "Cancel"],
				);
				if (enable !== "Yes, enable it") {
					ctx.ui.notify("Setup cancelled.", "info");
					return;
				}

				const configDir = join(getAgentDir(), "extensions");
				const configPath = join(configDir, "search.json");
				mkdirSync(configDir, { recursive: true });

				let existing: SearchConfig = {};
				if (existsSync(configPath)) {
					try {
						existing = JSON.parse(readFileSync(configPath, "utf-8"));
					} catch {
						// ignore
					}
				}

				// Handle backends needing instance URL (e.g. SearXNG)
				let backendConfig: BackendConfig = { enabled: true };
				if (def.needsInstanceUrl) {
					const instanceUrl = await ctx.ui.input("Enter your instance URL (e.g. http://localhost:8888):", {
						placeholder: "http://localhost:8888",
						validate: (v: string) =>
							v.trim().length > 0 ? undefined : "URL cannot be empty",
					});
					if (!instanceUrl) {
						ctx.ui.notify("Setup cancelled.", "info");
						return;
					}
					backendConfig.instanceUrl = instanceUrl.trim();
					// Optionally ask for API key (some instances require auth)
					const optKey = await ctx.ui.input("Optional API key (press Enter to skip):", {
						placeholder: "sk-... (optional)",
				});
					if (optKey && optKey.trim()) {
						backendConfig.apiKey = optKey.trim();
					}
				} else if (def.optionalKey) {
					// Optionally ask for API key if optional
					const optKey = await ctx.ui.input("Optional API key (press Enter to skip):", {
						placeholder: "sk-... (optional)",
					});
					if (optKey && optKey.trim()) {
						backendConfig.apiKey = optKey.trim();
					}
				}

				const updated: SearchConfig = {
					...existing,
					backends: {
						...existing.backends,
						[backend]: backendConfig,
					},
				};

				writeFileSync(configPath, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });
				ctx.ui.notify(`${label} enabled. Run /reload to activate.`, "success");
				return;
			}

			const key = await ctx.ui.input(`Enter your ${label} API key:`, {
				placeholder: "sk-...",
				validate: (v: string) =>
					v.trim().length > 0 ? undefined : "Key cannot be empty",
			});

			if (!key) {
				ctx.ui.notify("Setup cancelled.", "info");
				return;
			}

			const configDir = join(getAgentDir(), "extensions");
			const configPath = join(configDir, "search.json");

			mkdirSync(configDir, { recursive: true });

			let existing: SearchConfig = {};
			if (existsSync(configPath)) {
				try {
					existing = JSON.parse(readFileSync(configPath, "utf-8"));
				} catch {
					// ignore
				}
			}

			// SearXNG setup needs both instance URL and optional API key
			let backendConfig: BackendConfig = { enabled: true };
			if (backend === "searxng") {
				const url = await ctx.ui.input("Enter your SearXNG instance URL (e.g. http://localhost:8888):", {
					placeholder: "http://localhost:8888",
					validate: (v: string) =>
						v.trim().length > 0 ? undefined : "URL cannot be empty",
				});
				if (!url) {
					ctx.ui.notify("Setup cancelled.", "info");
					return;
				}
				backendConfig.instanceUrl = url.trim();
				// Optionally ask for API key (some instances require auth)
				const optionalKey = await ctx.ui.input("Optional API key (leave empty if none):", {
					placeholder: "sk-... (optional)",
				});
				if (optionalKey && optionalKey.trim()) {
					backendConfig.apiKey = optionalKey.trim();
				}
			} else {
				backendConfig.apiKey = key?.trim() || "";
			}

			const updated: SearchConfig = {
				...existing,
				backends: {
					...existing.backends,
					[backend]: backendConfig,
				},
			};

			writeFileSync(configPath, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });

			ctx.ui.notify(
				`${label} API key saved to ${configPath}. Run /reload to activate.`,
				"success",
			);
		},
	});

	pi.registerCommand("search-status", {
		description: "Show which search backends are configured and active",
		handler: async (_args, ctx) => {
			refreshConfig(ctx.cwd);

			const backendLabels: Record<string, string> = Object.fromEntries(
				Object.entries(BACKEND_DEFS).map(([k, v]) => [k, `${v.label}${k === "duckduckgo" ? " (free, no key)" : ""}`])
			);

			// Collect table rows first to compute aligned column widths
			type Row = [string, string, string];
			const rows: Row[] = [];

			for (const [name, label] of Object.entries(backendLabels)) {
				const { configured, source } = getKeySource(name, config);
				const bc = config.backends?.[name as keyof typeof config.backends];
				const samples = latencyMap.get(name) ?? [];
				const avgLatency = samples.length > 0
					? `${Math.round(samples.reduce((sum, s) => sum + s.ms, 0) / samples.length)}ms`
					: "\u2014";

				if (name === "duckduckgo") {
					rows.push([label, "\u2713 enabled, key: \u2014 (free)", avgLatency]);
				} else if (name === "marginalia" && bc?.enabled) {
					rows.push([label, "\u2713 enabled, key: optional (public)", avgLatency]);
				} else if (name === "searxng" && bc?.enabled) {
					const urlInfo = bc.instanceUrl ? `url: ${bc.instanceUrl}` : "no URL set";
					rows.push([label, `\u2713 enabled, ${urlInfo}${configured ? `, key: \u2713 (${source})` : ", key: \u2014"}`, avgLatency]);
				} else if (bc?.enabled && BACKEND_DEFS[name]?.optionalKey) {
					const keyInfo = configured ? `\u2713 (${source})` : "optional (keyless)";
					rows.push([label, `\u2713 enabled, key: ${keyInfo}`, avgLatency]);
				} else if (bc?.enabled) {
					rows.push([label, `\u2713 enabled, key: \u2713${source ? ` (${source})` : ""}`, avgLatency]);
				} else {
					rows.push([label, `\u2014 disabled${configured ? `, key: \u2713 (${source})` : ""}`, avgLatency]);
				}
			}

			// Compute column widths from headers + data
			const col1Header = "Backend";
			const col2Header = "Status";
			const col3Header = "Avg Latency";
			const w1 = rows.reduce((max, [c]) => Math.max(max, c.length), col1Header.length);
			const w2 = rows.reduce((max, [, s]) => Math.max(max, s.length), col2Header.length);
			const w3 = rows.reduce((max, [, , s]) => Math.max(max, s.length), col3Header.length);

			const pad = (s: string, w: number) => s + " ".repeat(w - s.length);

			const tableLines = [
				`| ${pad(col1Header, w1)} | ${pad(col2Header, w2)} | ${pad(col3Header, w3)} |`,
				`| ${"-".repeat(w1)} | ${"-".repeat(w2)} | ${"-".repeat(w3)} |`,
				...rows.map(([c1, c2, c3]) => `| ${pad(c1, w1)} | ${pad(c2, w2)} | ${pad(c3, w3)} |`),
			];

			const activeBackends = getActiveBackends();
			const resolvedDefault = activeBackends[0] || "none";
			const lines: string[] = [
				"## Search Backend Status",
				`Configured default: ${config.defaultBackend || "none"}`,
				`Resolved default: ${resolvedDefault}`,
				`Strategy: ${config.selectionStrategy || "sequential"}`,
				`Active: ${activeBackends.join(", ") || "none"}`,
				"",
				...tableLines,
			];

			if (activeBackends.length === 1 && activeBackends[0] === "duckduckgo") {
				lines.push("");
				lines.push("Only DuckDuckGo is active (no API key needed).");
				lines.push("Add a search backend with /search-setup to get more results.");
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});


	// -----------------------------------------------------------------------
	// Session start
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		clearCooldowns();
		refreshConfig(ctx.cwd);
		if (config.showStatus !== false) {
			const status = getActiveBackends().join(", ");
			ctx.ui.setStatus("search", `search: ${status}`);
		}
	});
}
