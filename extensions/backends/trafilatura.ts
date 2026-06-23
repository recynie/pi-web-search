/**
 * Trafilatura reader: local content extraction via the trafilatura CLI.
 *
 * Requires the Python package to be installed on PATH:
 *   pip install trafilatura
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatFetchError, sanitizeError, timeoutSignal } from "../utils.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export function titleFromMarkdown(markdown: string): string {
	const heading = markdown.match(/^#\s+(.+)$/m);
	return heading?.[1]?.trim() ?? "";
}

function truncateDiagnostic(text: string): string {
	return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function shouldDiagnoseUrl(error: unknown): boolean {
	const err = error as { code?: string | number; exitCode?: number; name?: string };
	return err?.name !== "AbortError" && (err?.exitCode !== undefined || typeof err?.code === "number");
}

async function diagnoseUrl(url: string, signal?: AbortSignal): Promise<string> {
	const fetchOptions = {
		redirect: "follow" as const,
		signal: timeoutSignal(signal, 10_000),
	};

	try {
		let response = await fetch(url, { ...fetchOptions, method: "HEAD" });

		// Some sites reject HEAD even though GET works. Retry with a tiny GET so the
		// diagnostic reflects the URL, not the site's HEAD support.
		if (response.status === 405) {
			response = await fetch(url, {
				...fetchOptions,
				method: "GET",
				headers: { Range: "bytes=0-0" },
			});
		}

		const statusText = response.statusText ? ` ${response.statusText}` : "";
		const contentType = response.headers.get("content-type");
		const contentNote = contentType ? `, content-type: ${contentType}` : "";

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			return `url check: ${sanitizeError(response.status, body || response.statusText || "HTTP error")}`;
		}

		return `url check: reachable (HTTP ${response.status}${statusText}${contentNote})`;
	} catch (error) {
		return `url check failed: ${formatFetchError(error)}`;
	}
}

function formatTrafilaturaError(error: unknown): string {
	const err = error as {
		code?: string | number;
		exitCode?: number;
		message?: string;
		stderr?: string;
		stdout?: string;
		name?: string;
	};

	if (err?.code === "ENOENT") {
		return "environment error: trafilatura CLI not found. Install it with `pip install trafilatura` and ensure it is on PATH.";
	}

	if (err?.name === "AbortError") {
		return "timeout: trafilatura did not finish before the fetch timeout; the site may be slow or unreachable";
	}

	const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
	const stdout = typeof err?.stdout === "string" ? err.stdout.trim() : "";
	const exitCode = err?.exitCode ?? (typeof err?.code === "number" ? err.code : undefined);
	const exitNote = exitCode !== undefined ? ` (exit ${exitCode})` : "";
	const output = stderr || stdout;

	if (output) {
		return truncateDiagnostic(`trafilatura CLI error${exitNote}: ${output}`);
	}

	// stderr/stdout empty: the CLI ran but gave us no details. In practice this is
	// usually a URL/download/extraction problem, not a missing binary.
	if (exitCode !== undefined) {
		return `trafilatura CLI error${exitNote}: no diagnostic output; likely URL download/HTTP/TLS failure or no extractable content`;
	}

	const message = typeof err?.message === "string" ? err.message.trim() : "unknown error";
	return truncateDiagnostic(`trafilatura CLI error: ${message}`);
}

function validateTrafilaturaUrl(url: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "invalid URL: expected an absolute http(s) URL";
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return `invalid URL: unsupported protocol ${parsed.protocol}; expected http or https`;
	}

	return undefined;
}

export async function fetchTrafilatura(
	url: string,
	signal?: AbortSignal,
): Promise<{ title: string; url: string; content: string }> {
	const urlError = validateTrafilaturaUrl(url);
	if (urlError) {
		throw new Error(`Trafilatura failed for ${url}: ${urlError}`);
	}

	let stdout: string;
	try {
		const result = await execFileAsync(
			"trafilatura",
			["-u", url, "--markdown", "--no-comments"],
			{
				signal: timeoutSignal(signal),
				maxBuffer: MAX_BUFFER_BYTES,
			},
		);
		stdout = result.stdout;
	} catch (error) {
		const urlDiagnostic = shouldDiagnoseUrl(error) ? `; ${await diagnoseUrl(url, signal)}` : "";
		throw new Error(`Trafilatura failed for ${url}: ${formatTrafilaturaError(error)}${urlDiagnostic}`);
	}

	const content = stdout.trim();
	if (!content) {
		throw new Error(
			`Trafilatura failed for ${url}: empty extraction: CLI succeeded but returned no content; ` +
			"the URL may be reachable but blocked, JS-rendered, binary, or have no extractable article text; " +
			await diagnoseUrl(url, signal),
		);
	}

	return {
		title: titleFromMarkdown(content),
		url,
		content,
	};
}
