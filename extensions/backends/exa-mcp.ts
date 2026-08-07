/**
 * Exa MCP backend — zero-config search and content extraction.
 */

import { timeoutSignal, sanitizeError } from "../utils.js";
import type { SearchResult } from "../types.js";

const EXA_MCP_ENDPOINT = "https://mcp.exa.ai/mcp";
let requestId = 0;

interface MCPResponse {
	result?: { content?: Array<{ type: string; text?: string }> };
	error?: { code: number; message: string };
}

function parseMcpResults(text: string): SearchResult[] {
	try {
		const parsed = JSON.parse(text) as unknown;
		const items = Array.isArray(parsed)
			? parsed
			: (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).results)
				? (parsed as Record<string, unknown>).results as unknown[]
				: undefined);
		if (items) {
			return items.map(item => {
				const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
				return {
					title: String(value.title || ""),
					url: String(value.url || ""),
					snippet: String(value.snippet || value.description || ""),
					content: String(value.content || ""),
				};
			});
		}
	} catch {
		// Fall through to the tab-separated response format.
	}

	const results: SearchResult[] = [];
	for (const line of text.split("\n")) {
		const parts = line.split("\t");
		if (parts.length >= 2) {
			results.push({ title: parts[1] || "", url: parts[0] || "", snippet: parts[2] || "" });
		}
	}
	return results;
}

async function callMCP(
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[] }> {
	const response = await fetch(EXA_MCP_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: ++requestId,
			method: "tools/call",
			params: { arguments: params },
		}),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Exa MCP ${sanitizeError(response.status, text)}`);
	}

	const data = await response.json() as MCPResponse;
	if (data.error) throw new Error(`Exa MCP error: ${data.error.message}`);
	if (!data.result?.content) return { results: [] };
	const text = data.result.content
		.filter(item => item.type === "text")
		.map(item => item.text || "")
		.join("\n");
	return { results: parseMcpResults(text) };
}

export async function searchExaMCP(
	query: string,
	numResults: number,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[] }> {
	return callMCP({
		name: "web_search_exa",
		arguments: { query, numResults: Math.min(numResults, 20) },
	}, signal);
}

export async function fetchExaMCP(
	url: string,
	signal?: AbortSignal,
): Promise<{ title: string; url: string; content: string }> {
	const result = await callMCP({ name: "web_fetch_exa", arguments: { url } }, signal);
	const first = result.results[0];
	if (!first) throw new Error(`Exa MCP fetch returned no content for ${url}`);
	return {
		title: first.title || "",
		url: first.url || url,
		content: first.content || first.snippet || "",
	};
}
