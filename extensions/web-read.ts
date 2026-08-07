/** Web page reading extension resource. Enable or disable it with `pi config`. */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { timeoutSignal, sanitizeError, formatFetchError, MISSING_KEY_HELP, validateUrl } from "./utils.js";
import { resolveBackendKey } from "./credentials.js";
import { fetchSofya } from "./backends/sofya.js";
import { fetchTrafilatura } from "./backends/trafilatura.js";
import { fetchFirecrawl } from "./backends/firecrawl.js";
import { fetchExaContents } from "./backends/exa.js";
import { fetchExaMCP } from "./backends/exa-mcp.js";
import { config, refreshConfig } from "./config.js";

export default function (pi: ExtensionAPI) {
	refreshConfig(process.cwd(), true);

	// -----------------------------------------------------------------------
	// Tool: web_read — Read/extract content from a URL
	// -----------------------------------------------------------------------

	const WEB_READ_DEFAULT_MAX_CHARS = 10_000;

	/** Shared helper: fetch content from a single reader backend. */
	async function fetchWithReader(
		reader: string,
		url: string,
		signal: AbortSignal | undefined,
		params: { fresh?: boolean; keywords?: string[]; mode?: string },
	): Promise<string> {
		if (reader === "sofya") {
			const sofyaKey = resolveBackendKey("sofya", config);
			if (!sofyaKey) {
				throw new Error(`Sofya reader selected but no API key configured. ${MISSING_KEY_HELP}`);
			}
			const result = await fetchSofya(url, sofyaKey, signal);
			return result.content;
		}

		if (reader === "trafilatura") {
			const result = await fetchTrafilatura(url, signal);
			return result.content;
		}

		if (reader === "firecrawl") {
			const key = resolveBackendKey("firecrawl", config);
			const result = await fetchFirecrawl(url, key, signal);
			return result.content;
		}

		if (reader === "exa") {
			const key = resolveBackendKey("exa", config);
			if (!key) throw new Error(`Exa reader selected but no API key configured. ${MISSING_KEY_HELP}`);
			const result = await fetchExaContents(url, key, signal);
			return result.content;
		}

		if (reader === "exa_mcp") {
			const result = await fetchExaMCP(url, signal);
			return result.content;
		}

		// Jina Reader: free, supports keywords and mode hints.
		const readerUrl = new URL("https://r.jina.ai/" + url);
		const headers: Record<string, string> = {
			"Accept": "text/plain",
		};
		const jinaKey = resolveBackendKey("jina", config);
		if (jinaKey) {
			headers["Authorization"] = `Bearer ${jinaKey}`;
		}
		if (params.fresh) {
			headers["x-no-cache"] = "true";
		}
		if (params.keywords && params.keywords.length > 0) {
			headers["x-keywords"] = params.keywords.join(", ");
		}
		if (params.mode) {
			headers["x-respond-with"] = params.mode === "rush" ? "text" : "markdown";
		}

		let response: Response;
		try {
			response = await fetch(readerUrl.toString(), {
				signal: timeoutSignal(signal),
				headers,
			});
		} catch (error) {
			throw new Error(`Failed to read ${url}: ${formatFetchError(error)}`);
		}

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`Failed to read ${url}: ${sanitizeError(response.status, text)}`);
		}

		const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
		if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
			throw new Error(`Failed to read ${url}: response too large (${contentLength} bytes, limit 2097152)`);
		}
		return await response.text();
	}

	/** Fetch raw HTML directly as a last-resort fallback for web_read. */
	async function fetchRawHtmlFallback(
		url: string,
		signal: AbortSignal | undefined,
	): Promise<string> {
		const urlError = validateUrl(url);
		if (urlError) {
			throw new Error(`HTML fallback failed for ${url}: ${urlError}`);
		}

		let response: Response;
		try {
			response = await fetch(url, {
				signal: timeoutSignal(signal),
				headers: { Accept: "text/html,*/*;q=0.8" },
			});
		} catch (error) {
			throw new Error(`HTML fallback failed for ${url}: ${formatFetchError(error)}`);
		}

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(
				`HTML fallback failed for ${url}: ${sanitizeError(response.status, text || response.statusText || "HTTP error")}`,
			);
		}

		return await response.text();
	}

	pi.registerTool({
		name: "web_read",
		label: "Read Web Page",
		description:
			"Fetch a URL as markdown. Use keywords for long pages, rush for speed, smart for better narrowing. " +
			"Use reader param to select Trafilatura, Jina, Sofya, Firecrawl, Exa, or Exa MCP. " +
			"When omitted, falls back to readerPriority from config. " +
			"If webReadHtmlFallback is enabled, returns raw HTML with a warning after all readers fail. " +
			"Output is truncated to " + WEB_READ_DEFAULT_MAX_CHARS.toLocaleString() + " chars by default. " +
			"Use maxChars to override. When truncated, full content is saved to a temp file and its path is shown.",
		promptSnippet: "Read content from a web page (supports markdown extraction)",
		promptGuidelines: [
			"Use web_read when you need to read the content of a specific URL",
			"Add keywords for long pages when you know the relevant terms",
			"Choose rush for speed or smart for higher-quality narrowing",
			"Set maxChars to control truncation threshold, or set PI_WEB_READ_MAX_CHARS env var globally",
			"When truncated, full content is saved to a temp file; use read to inspect it",
			"Configure readerPriority in search.json for automatic fallback between readers",
			"Enable webReadHtmlFallback in search.json only when raw HTML is useful as a last resort",
		],
		parameters: Type.Object({
			url: Type.String({
				description: "HTTP(S) URL or bare domain to fetch",
			}),
			maxChars: Type.Optional(
				Type.Number({
					description:
						"Maximum characters to return. Default: " + WEB_READ_DEFAULT_MAX_CHARS.toLocaleString() + ". " +
						"Override via PI_WEB_READ_MAX_CHARS env var. When truncated, full content is saved to a temp file.",
					default: WEB_READ_DEFAULT_MAX_CHARS,
				}),
			),
			fresh: Type.Optional(
				Type.Boolean({
					description: "Bypass cache when freshness matters",
				}),
			),
			keywords: Type.Optional(
				Type.Array(Type.String(), {
					description: "Keyword to focus extraction on relevant sections",
				}),
			),
			mode: Type.Optional(
				StringEnum(["rush", "smart"] as const, {
					description: "rush = faster mode, smart = better section selection on long/noisy pages",
				}),
			),
			reader: Type.Optional(
				StringEnum(["jina", "sofya", "trafilatura", "firecrawl", "exa", "exa_mcp"] as const, {
					description:
						"Reader backend. Overrides the configured readerPriority. " +
						"Trafilatura, Jina, and Exa MCP need no key; Firecrawl supports keyless access; " +
						"Sofya and Exa require API keys."
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			refreshConfig(ctx.cwd);

			const url = params.url.startsWith("https://") || params.url.startsWith("http://")
				? params.url
				: `https://${params.url}`;
			const urlError = validateUrl(url);
			if (urlError) throw new Error(urlError);

			// Determine maxChars: explicit param > PI_WEB_READ_MAX_CHARS env var > default
			const envMaxChars = process.env.PI_WEB_READ_MAX_CHARS
				? parseInt(process.env.PI_WEB_READ_MAX_CHARS, 10)
				: undefined;
			const maxChars = params.maxChars ?? envMaxChars ?? WEB_READ_DEFAULT_MAX_CHARS;

			// Determine reader list:
			// - If explicit reader param was passed, use it alone (no fallback).
			// - Otherwise, use readerPriority from config; if unset, default to ["trafilatura"].
			const readers: string[] = params.reader
				? [params.reader]
				: (config.readerPriority?.length ? config.readerPriority : ["trafilatura"]);

			// Truncation helper (shared across all branches)
			const truncate = (content: string) => {
				const isTruncated = maxChars > 0 && content.length > maxChars;
				if (!isTruncated) return { truncated: content, tempPath: undefined as string | undefined, isTruncated };
				const tmpDir = tmpdir();
				const safeDomain = url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9.-]/g, "_");
				const fileName = `pi-web-read-${safeDomain}-${randomUUID().slice(0, 8)}.md`;
				const tempPath = join(tmpDir, fileName);
				writeFileSync(tempPath, content, "utf-8");
				return {
					truncated: content.slice(0, maxChars) +
						`\n\n[... truncated, full length: ${content.length} chars]\n` +
						`[Full content saved to: ${tempPath}]\n`,
					tempPath,
					isTruncated,
				};
			};

			const errors: Array<{ reader: string; cause: string }> = [];
			const htmlFallbackEnabled = config.webReadHtmlFallback === true;

			for (const reader of readers) {
				try {
					const content = await fetchWithReader(reader, url, signal, params);
					if (!content.trim()) throw new Error(`${reader} returned no content for ${url}`);
					const { truncated, tempPath, isTruncated } = truncate(content);
					return {
						content: [{ type: "text", text: truncated }],
						details: {
							url,
							reader,
							length: content.length,
							truncated: isTruncated,
							tempPath,
							fallbackErrors: errors.length > 0 ? errors : undefined,
						},
					};
				} catch (err) {
					errors.push({ reader, cause: (err as Error).message });
					// If only one reader in list and HTML fallback is disabled, preserve direct-error semantics.
					if (readers.length === 1 && !htmlFallbackEnabled) {
						throw err;
					}
				}
			}

			if (htmlFallbackEnabled) {
				try {
					const content = await fetchRawHtmlFallback(url, signal);
					const { truncated, tempPath, isTruncated } = truncate(content);
					return {
						content: [{ type: "text", text: truncated }],
						details: {
							url,
							reader: "html",
							length: content.length,
							truncated: isTruncated,
							tempPath,
							fallbackErrors: errors,
							rawHtmlFallback: true,
							warning: "All web_read readers failed; returned raw HTML without extraction.",
						},
					};
				} catch (err) {
					errors.push({ reader: "html", cause: (err as Error).message });
					throw new Error(`All web readers failed for ${url}; HTML fallback also failed. ` +
						errors.map(e => `${e.reader}: ${e.cause}`).join("; "));
				}
			}

			// All readers failed
			throw new Error(`All web readers failed for ${url}. ` +
				errors.map(e => `${e.reader}: ${e.cause}`).join("; "));
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as {
				url: string;
				reader: string;
				length: number;
				truncated: boolean;
				tempPath?: string;
				fallbackErrors?: Array<{ reader: string; cause: string }>;
				rawHtmlFallback?: boolean;
				warning?: string;
			} | undefined;
			const text = result.content[0];
			const raw = text?.type === "text" ? text.text : "";
			if (!details) return new Text(raw, 0, 0);

			const displayUrl = details.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
			const sizeKb = Math.round(details.length / 1024);
			const truncMark = details.truncated ? theme.fg("warning", " [truncated]") : "";

			// Build failure summary (deduplicated reader names)
			const failedReaders = details.fallbackErrors
				?.map(e => e.reader)
				.filter((r, i, a) => a.indexOf(r) === i) ?? [];
			const failureMark = failedReaders.length > 0
				? " " + theme.fg("warning", `⚠ [reader failed: ${failedReaders.join(", ")}]`)
				: "";
			const htmlFallbackMark = details.rawHtmlFallback
				? " " + theme.fg("warning", "⚠ [raw HTML fallback]")
				: "";

			if (!expanded) {
				const hint = keyHint("app.tools.expand", "expand");
				return new Text(
					theme.fg("accent", displayUrl) +
					theme.fg("muted", ` · ${sizeKb}KB via ${details.reader}`) +
					truncMark +
					htmlFallbackMark +
					failureMark +
					theme.fg("dim", ` (${hint})`),
					0, 0,
				);
			}

			// Expanded: render content with warning/error preamble
			let output = raw;
			const preambleParts: string[] = [];
			if (details.rawHtmlFallback && details.warning) {
				preambleParts.push(`${theme.fg("warning", "⚠")} ${details.warning}`);
			}
			if (details.fallbackErrors?.length) {
				preambleParts.push(...details.fallbackErrors
					.map(e => `${theme.fg("warning", "⚠")} ${e.reader} failed: ${e.cause}`));
			}
			if (preambleParts.length > 0) {
				output = preambleParts.join("\n") + "\n\n---\n\n" + raw;
			}

			return new Text(output, 0, 0);
		},
	});

}
