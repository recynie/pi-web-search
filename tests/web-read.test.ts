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

describe("web_read tool", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(global, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		vi.resetModules();
	});

	it("maps objective to Jina CSS selector header", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			text: async () => "ok",
		} as Response);

		const tools: Record<string, { execute: Function }> = {};
		const extension = (await import("../extensions/search-hub.js")).default;
		extension({
			registerTool(tool: { name: string; execute: Function }) {
				tools[tool.name] = tool;
			},
			registerCommand() {},
			on() {},
		} as any);

		await tools.web_read.execute("call", {
			url: "example.com",
			objective: "main.article-body",
			mode: "smart",
		}, undefined, undefined, { cwd: process.cwd() });

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [requestUrl, requestInit] = fetchSpy.mock.calls[0];
		expect(requestUrl).toBe("https://r.jina.ai/https://example.com");
		expect((requestInit as RequestInit).headers).toMatchObject({
			Accept: "text/plain",
			"x-target-selector": "main.article-body",
			"x-respond-with": "markdown",
		});
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
		}, undefined, undefined, { cwd: process.cwd() })).rejects.toThrow(
			"Failed to read https://example.com: fetch failed: UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error",
		);
	});
});
