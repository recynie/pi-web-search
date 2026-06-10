/**
 * Trafilatura reader: local content extraction via the trafilatura CLI.
 *
 * Requires the Python package to be installed on PATH:
 *   pip install trafilatura
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { timeoutSignal } from "../utils.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export function titleFromMarkdown(markdown: string): string {
	const heading = markdown.match(/^#\s+(.+)$/m);
	return heading?.[1]?.trim() ?? "";
}

function formatTrafilaturaError(error: unknown): string {
	const err = error as {
		code?: string;
		message?: string;
		stderr?: string;
		stdout?: string;
		name?: string;
	};

	if (err?.code === "ENOENT") {
		return "trafilatura CLI not found. Install it with `pip install trafilatura` and ensure it is on PATH.";
	}

	if (err?.name === "AbortError") {
		return "operation timed out or was aborted";
	}

	const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
	const stdout = typeof err?.stdout === "string" ? err.stdout.trim() : "";
	const message = typeof err?.message === "string" ? err.message : "unknown error";
	return (stderr || stdout || message).slice(0, 500);
}

export async function fetchTrafilatura(
	url: string,
	signal?: AbortSignal,
): Promise<{ title: string; url: string; content: string }> {
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
		throw new Error(`Trafilatura failed for ${url}: ${formatTrafilaturaError(error)}`);
	}

	const content = stdout.trim();
	if (!content) {
		throw new Error(`Trafilatura failed for ${url}: no content returned`);
	}

	return {
		title: titleFromMarkdown(content),
		url,
		content,
	};
}
