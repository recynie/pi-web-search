/**
 * SearXNG backend — self-hosted metasearch, aggregates 70+ providers.
 * Needs instance URL configured in search.json.
 */

import { timeoutSignal, sanitizeError } from "../utils.js";
import { parseSearXNG } from "../../backends/parsers.js";
import type { BackendSearchResponse } from "../types.js";

function formatUnresponsiveEngines(data: Record<string, unknown>): string | undefined {
	const raw = data.unresponsive_engines;
	if (!Array.isArray(raw) || raw.length === 0) return undefined;

	const engines = raw.map((entry) => {
		if (Array.isArray(entry)) {
			const [engine, reason] = entry;
			const engineText = String(engine ?? "unknown");
			return reason ? `${engineText} (${String(reason)})` : engineText;
		}
		if (entry && typeof entry === "object") {
			const item = entry as Record<string, unknown>;
			const engine = String(item.engine ?? item.name ?? "unknown");
			const reason = item.error ?? item.reason ?? item.message;
			return reason ? `${engine} (${String(reason)})` : engine;
		}
		return String(entry);
	});

	return engines.join(", ");
}

export async function searchSearXNG(
	query: string,
	numResults: number,
	apiKey: string | undefined,
	instanceUrl: string | undefined,
	signal?: AbortSignal,
): Promise<BackendSearchResponse> {
	if (!instanceUrl) {
		throw new Error("SearXNG instance URL not configured. Set searxng.instanceUrl in search.json (e.g. http://localhost:8888)");
	}

	const baseUrl = instanceUrl.replace(/\/+$/, "");
	const params = new URLSearchParams({
		q: query,
		format: "json",
		count: String(Math.min(numResults, 50)),
	});

	const headers: Record<string, string> = {
		"Accept": "application/json",
	};
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}

	const response = await fetch(`${baseUrl}/search?${params}`, {
		method: "GET",
		headers,
		signal: timeoutSignal(signal),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`SearXNG ${sanitizeError(response.status, text)}`);
	}

	const data = (await response.json()) as Record<string, unknown>;
	const results = parseSearXNG(data, numResults);
	const unresponsiveEngines = formatUnresponsiveEngines(data);

	if (results.length === 0 && unresponsiveEngines) {
		throw new Error(`SearXNG returned no results and reported unresponsive engines: ${unresponsiveEngines}`);
	}

	return {
		results,
		warning: unresponsiveEngines
			? `SearXNG reported unresponsive engines: ${unresponsiveEngines}`
			: undefined,
	};
}
