/**
 * Dispatch logic: selection strategies, RRF combiner, fallback ordering.
 */

import type { SearchResult, SearchResultWithBackend } from "./types.js";
import { roundRobinIndex, incrementRoundRobin } from "./config.js";
import { scoreBackends } from "./scoring.js";

// ---------------------------------------------------------------------------
// Selection strategies
// ---------------------------------------------------------------------------

export function selectBackendsForFallback(
	strategy: "sequential" | "random" | "round-robin" | "best-latency",
	activeBackends: string[],
): string[] {
	const backends = [...activeBackends];
	if (backends.length === 0) return [];
	switch (strategy) {
		case "random": {
			for (let i = backends.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[backends[i], backends[j]] = [backends[j], backends[i]];
			}
			return backends;
		}
		case "round-robin": {
			const index = roundRobinIndex % backends.length;
			incrementRoundRobin();
			const selected = backends[index];
			// Put selected first, then the rest
			return [selected, ...backends.filter((b) => b !== selected)];
		}
		case "best-latency": {
			// Use smart composite scoring (success rate + latency + quality)
			return scoreBackends(backends).map(s => s.backend);
		}
		case "sequential":
		default:
			return backends;
	}
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion (RRF)
// ---------------------------------------------------------------------------

function normalizeUrl(url: string): string {
	try {
		const u = new URL(url);
		u.hash = "";
		u.pathname = u.pathname.replace(/\/+$/, "") || "/";
		return u.toString().toLowerCase();
	} catch {
		return url.toLowerCase();
	}
}

/**
 * Merge results from multiple backends using Reciprocal Rank Fusion (k=60).
 * URL dedup keeps the result with the richest content.
 */
export function reciprocalRankFusion(
	backendResults: Array<{ backend: string; results: SearchResultWithBackend[] }>,
	maxResults: number,
): SearchResultWithBackend[] {
	const K = 60;
	const urlMap = new Map<string, { rrfScore: number; result: SearchResultWithBackend; backends: string[] }>();

	for (const { backend, results } of backendResults) {
		for (let rank = 0; rank < results.length; rank++) {
			const r = results[rank];
			const key = normalizeUrl(r.url);

			const existing = urlMap.get(key);
			const rrfContribution = 1 / (K + rank + 1);

			if (existing) {
				existing.rrfScore += rrfContribution;
				existing.backends.push(backend);
				// Prefer result with richer content
				const existingLen = (existing.result.content ?? existing.result.snippet ?? "").length;
				const newLen = (r.content ?? r.snippet ?? "").length;
				if (newLen > existingLen) {
					existing.result = r;
				}
				// Keep backend label from higher-ranked result
			} else {
				urlMap.set(key, {
					rrfScore: rrfContribution,
					result: { ...r, backend },
					backends: [backend],
				});
			}
		}
	}

	return Array.from(urlMap.values())
		.sort((a, b) => {
			// Primary: RRF score descending
			if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
			// Secondary: number of backends that found it
			return b.backends.length - a.backends.length;
		})
		.slice(0, maxResults)
		.map(entry => entry.result);
}
