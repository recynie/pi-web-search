import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({
	StringEnum: (_values: readonly string[], options: Record<string, unknown>) => options,
}));

vi.mock("typebox", () => ({
	Type: {
		Object: (value: unknown) => value,
		String: (value: unknown) => value,
		Optional: (value: unknown) => value,
		Boolean: (value: unknown) => value,
		Array: (...args: unknown[]) => args,
		Number: (value: unknown) => value,
	},
}));
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
	execFile: execFileMock,
}));

describe("web_read tool", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(global, "fetch");
	});

	afterEach(() => {
		execFileMock.mockReset();
		fetchSpy.mockRestore();
		vi.resetModules();
	});

	it("surfaces fetch cause details in thrown error", async () => {
		fetchSpy.mockRejectedValueOnce(Object.assign(new Error("fetch failed"), {
			cause: {
				code: "UND_ERR_CONNECT_TIMEOUT",
				message: "Connect Timeout Error",
			},
		}));

		const tools: Record<string, { execute: Function }> = {};
		const extension = (await import("../extensions/search-hub.js")).default;
		extension({
			registerTool(tool: { name: string; execute: Function }) {
				tools[tool.name] = tool;
			},
			registerCommand() {},
			on() {},
		} as any);

		await expect(tools.web_read.execute("call", {
			url: "https://example.com",
			reader: "jina",
		}, undefined, undefined, { cwd: process.cwd() })).rejects.toThrow(
			"Failed to read https://example.com: fetch failed: UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error",
		);
	});

	it("uses Trafilatura reader by default", async () => {
		execFileMock.mockImplementation((_cmd, _args, _options, callback) => {
			callback(null, { stdout: "# Example Title\n\nExtracted content", stderr: "" });
		});

		const tools: Record<string, { execute: Function }> = {};
		const extension = (await import("../extensions/search-hub.js")).default;
		extension({
			registerTool(tool: { name: string; execute: Function }) {
				tools[tool.name] = tool;
			},
			registerCommand() {},
			on() {},
		} as any);

		const result = await tools.web_read.execute("call", {
			url: "https://example.com",
		}, undefined, undefined, { cwd: process.cwd() });

		expect(execFileMock).toHaveBeenCalledWith(
			"trafilatura",
			["-u", "https://example.com", "--markdown", "--no-comments"],
			expect.objectContaining({ maxBuffer: 10 * 1024 * 1024 }),
			expect.any(Function),
		);
		expect(result.content[0].text).toBe("# Example Title\n\nExtracted content");
		expect(result.details).toMatchObject({ reader: "trafilatura", url: "https://example.com" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("titleFromMarkdown", () => {
	it("returns the first markdown H1 title", async () => {
		const { titleFromMarkdown } = await import("../extensions/backends/trafilatura.js");
		expect(titleFromMarkdown("intro\n# Main Title\n\nBody")).toBe("Main Title");
	});

	it("returns empty string when no H1 title exists", async () => {
		const { titleFromMarkdown } = await import("../extensions/backends/trafilatura.js");
		expect(titleFromMarkdown("Plain body text")).toBe("");
	});
});
