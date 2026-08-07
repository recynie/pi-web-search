/**
 * Exa backend — AI-native search and content extraction, needs API key.
 * Tracks monthly usage (1000 req/month, warns at 800).
 */

import { timeoutSignal, sanitizeError, checkExaUsage, incrementExaUsage } from "../utils.js";
import { parseExa } from "../../backends/parsers.js";
import type { SearchResult } from "../types.js";

function exaError(prefix: string, status: number, text: string): Error {
	let detail = text;
	try {
		const json = JSON.parse(text);
		detail = json.error || json.message || text;
	} catch {
		// Use the raw response body.
	}
	return new Error(`${prefix} ${sanitizeError(status, detail)}`);
}

/** Fetch a single URL as clean text via Exa Contents API. */
export async function fetchExaContents(
	url: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ title: string; url: string; content: string; warning?: string }> {
	const preWarning = checkExaUsage();
	const response = await fetch("https://api.exa.ai/contents", {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-api-key": apiKey },
		body: JSON.stringify({ urls: [url], text: true }),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw exaError("Exa contents", response.status, text);
	}

	const postWarning = incrementExaUsage();
	const data = (await response.json()) as Record<string, unknown>;
	const results = Array.isArray(data.results) ? data.results as Array<Record<string, unknown>> : [];
	const first = results[0];
	if (!first) throw new Error(`Exa contents returned no results for ${url}`);

	const statuses = Array.isArray(data.statuses) ? data.statuses as Array<Record<string, unknown>> : [];
	const urlStatus = statuses.find(status => status.id === url);
	if (urlStatus?.status === "error") {
		const error = urlStatus.error as Record<string, unknown> | undefined;
		throw new Error(`Exa contents failed for ${url}: ${String(error?.tag || "unknown")}`);
	}

	return {
		title: (first.title as string) || "",
		url: (first.url as string) || url,
		content: (first.text as string) || "",
		warning: preWarning || postWarning || undefined,
	};
}

export async function searchExa(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[]; warning?: string }> {
	const preWarning = checkExaUsage();
	const response = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-api-key": apiKey },
		body: JSON.stringify({
			query,
			numResults: Math.min(numResults, 25),
			contents: { text: true, highlights: true },
		}),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw exaError("Exa", response.status, text);
	}

	const postWarning = incrementExaUsage();
	const data = (await response.json()) as Record<string, unknown>;
	return {
		results: parseExa(data, numResults),
		warning: preWarning || postWarning || undefined,
	};
}
