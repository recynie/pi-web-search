/**
 * Shared utilities for pi-search-hub extension.
 */

import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HTTP_TIMEOUT_MS = 30_000;
export const COOLDOWN_MS = 2_000;
export const COMMAND_TIMEOUT_MS = 5_000;

export const MISSING_KEY_HELP =
	"Set the API key via env var (SEARCH_<BACKEND>_API_KEY), " +
	"config reference (\"apiKey\": \"SOME_ENV_VAR\"), " +
	"shell command (\"apiKey\": \"!pass show api/backend\"), " +
	"or a literal key in ~/.pi/agent/extensions/search.json. " +
	"DuckDuckGo needs no key. Marginalia uses a shared public key (optional)."

// ---------------------------------------------------------------------------
// Agent directory
// ---------------------------------------------------------------------------

export function getAgentDir(): string {
	return join(process.env.HOME || process.env.USERPROFILE || "~", ".pi", "agent");
}

// ---------------------------------------------------------------------------
// Per-backend cooldown
// ---------------------------------------------------------------------------

const backendCooldowns = new Map<string, number>();

export function waitForCooldown(backend: string): Promise<void> {
	const until = backendCooldowns.get(backend);
	if (!until) return Promise.resolve();
	const delay = until - Date.now();
	if (delay <= 0) return Promise.resolve();
	return new Promise(r => setTimeout(r, delay));
}

export function markCooldown(backend: string) {
	backendCooldowns.set(backend, Date.now() + COOLDOWN_MS);
}

export function clearCooldowns() {
	backendCooldowns.clear();
}

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

/** Combine an optional caller signal with a timeout (default or custom). */
export function timeoutSignal(signal?: AbortSignal, timeoutMs?: number): AbortSignal | undefined {
	const effectiveTimeout = timeoutMs ?? HTTP_TIMEOUT_MS;
	if (!signal) return AbortSignal.timeout(effectiveTimeout);
	return AbortSignal.any([signal, AbortSignal.timeout(effectiveTimeout)]);
}

// ---------------------------------------------------------------------------
// Search result cache (LRU with TTL)
// ---------------------------------------------------------------------------

export interface CacheEntry<T> {
	value: T;
	timestamp: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_CACHE_MAX = 100;

export class SearchCache<T> {
	private cache = new Map<string, CacheEntry<T>>();
	private readonly ttlMs: number;
	private readonly maxSize: number;

	constructor(ttlMs = DEFAULT_CACHE_TTL_MS, maxSize = DEFAULT_CACHE_MAX) {
		this.ttlMs = ttlMs;
		this.maxSize = maxSize;
	}

	get(key: string): T | undefined {
		const entry = this.cache.get(key);
		if (!entry) return undefined;
		if (Date.now() - entry.timestamp > this.ttlMs) {
			this.cache.delete(key);
			return undefined;
		}
		// LRU: move to end (most recently used)
		this.cache.delete(key);
		this.cache.set(key, entry);
		return entry.value;
	}

	set(key: string, value: T): void {
		// Evict oldest if at capacity
		if (this.cache.size >= this.maxSize) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
		this.cache.set(key, { value, timestamp: Date.now() });
	}

	clear(): void {
		this.cache.clear();
	}

	get size(): number {
		return this.cache.size;
	}
}

// Global search result cache instance
export const searchCache = new SearchCache<Array<{ title: string; url: string; snippet?: string; content?: string }>>();

/** Build a cache key from query + backend + numResults. */
export function cacheKey(query: string, backend: string, numResults: number): string {
	return `${backend}:${numResults}:${query}`;
}

// ---------------------------------------------------------------------------
// Error sanitization
// ---------------------------------------------------------------------------

/** Sanitize API error text — truncate and strip potential secrets. */
export function sanitizeError(status: number, text: string): string {
	const safe = text
		// Redact "Bearer <token>" and "Token <value>" patterns
		.replace(/(bearer|token)\s+[\w.\/-]{8,}/gi, "$1 [redacted]")
		// Redact key=value or "key": "value" pairs for known secret keys
		.replace(/(api[-_]?key|bearer|token|authorization|secret|password)["']?\s*[:=]\s*["']?[\w.\/-]{8,}/gi, "[redacted]")
		// Redact JSON key-value pairs where the value looks like a key
		.replace(/"(?:api[-_]?key|apiKey|token|secret|password|bearer)"\s*:\s*"[^"']{8,}"/gi, '"[redacted]"')
		// Redact x-api-key / Authorization header values in raw text
		.replace(/(x-api-key|authorization)\s*:\s*[\w.\/-]{8,}/gi, "$1: [redacted]")
		.slice(0, 300);
	return `API error (${status}): ${safe}`;
}

export function formatFetchError(error: unknown): string {
	const err = error as { message?: string; name?: string; cause?: { code?: string; message?: string } };
	const details: string[] = [];

	if (typeof err?.message === "string" && err.message.length > 0) {
		details.push(err.message);
	}

	if (typeof err?.cause?.code === "string" && err.cause.code.length > 0) {
		details.push(err.cause.code);
	}

	if (
		typeof err?.cause?.message === "string" &&
		err.cause.message.length > 0 &&
		err.cause.message !== err.message
	) {
		details.push(err.cause.message);
	}

	if (details.length === 0 && typeof err?.name === "string" && err.name.length > 0) {
		details.push(err.name);
	}

	return details.join(": ") || "unknown fetch error";
}
