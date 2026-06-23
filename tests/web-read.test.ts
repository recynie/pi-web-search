import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// -----------------------------------------------------------------------
// Mock pi dependencies (peerDependencies — may not be installed)
// -----------------------------------------------------------------------

vi.mock("@earendil-works/pi-coding-agent", () => ({
	ExtensionAPI: class {},
	keyHint: (key: string) => `[hint:${key}]`,
}));

vi.mock("@earendil-works/pi-tui", () => ({
	Text: class Text {
		content: string;
		x: number;
		y: number;
		constructor(content: string, x: number, y: number) {
			this.content = content;
			this.x = x;
			this.y = y;
		}
	},
}));

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

// Mock child_process — execFile uses callback style (matches promisify pattern)
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
	execFile: execFileMock,
}));

// Mock credentials module so resolveBackendKey works predictably
vi.mock("../extensions/credentials.js", async () => {
	const actual = await vi.importActual("../extensions/credentials.js");
	return {
		...actual as any,
		resolveBackendKey: vi.fn((backend: string) => {
			if (backend === "sofya") return "test-sofya-key";
			return undefined;
		}),
	};
});

// We need config.ts's refreshConfig to not overwrite our test settings.
// We keep the mutable `config` reference (so search-hub.ts reads the same object),
// but make refreshConfig a no-op that preserves whatever is already on `config`.
vi.mock("../extensions/config.js", async () => {
	const actual = await vi.importActual("../extensions/config.js");
	const mod = { ...actual as any };
	// Wrap refreshConfig to preserve existing readerPriority (don't reload from disk)
	const origRefreshConfig = mod.refreshConfig;
	mod.refreshConfig = vi.fn((cwd: string, force?: boolean) => {
		// Don't reload from disk — just use TTL cache to skip.
		// For test purposes, we skip the disk reload entirely.
		return mod.getActiveBackends();
	});
	// Ensure config is a mutable ref that search-hub.ts can read
	return mod;
});

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function fakeToolRegistration(tools: Record<string, any>) {
	return {
		registerTool(tool: any) {
			tools[tool.name] = tool;
		},
		registerCommand() {},
		on() {},
		ui: { setStatus() {} },
		hasUI: false,
	};
}

describe("web_read tool", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(global, "fetch");
		vi.stubEnv("HOME", "/fake-home");
	});

	afterEach(() => {
		execFileMock.mockReset();
		fetchSpy.mockRestore();
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	// -----------------------------------------------------------------------
	// Explicit reader = single reader, no fallback
	// -----------------------------------------------------------------------

	it("throws directly when explicit reader param fails (no fallback)", async () => {
		fetchSpy.mockRejectedValueOnce(Object.assign(new Error("fetch failed"), {
			cause: {
				code: "UND_ERR_CONNECT_TIMEOUT",
				message: "Connect Timeout Error",
			},
		}));

		const tools: Record<string, any> = {};
		const extension = (await import("../extensions/search-hub.js")).default;
		extension(fakeToolRegistration(tools));

		await expect(tools.web_read.execute("call", {
			url: "https://example.com",
			reader: "jina",
		}, undefined, undefined, { cwd: process.cwd() })).rejects.toThrow(
			"Failed to read https://example.com: fetch failed: UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error",
		);
	});

	it("throws directly when explicit reader param is trafilatura and CLI is missing", async () => {
		execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, callback: Function) => {
			const err = new Error("spawn ENOENT");
			(err as any).code = "ENOENT";
			callback(err, null);
		});

		const tools: Record<string, any> = {};
		const extension = (await import("../extensions/search-hub.js")).default;
		extension(fakeToolRegistration(tools));

		await expect(tools.web_read.execute("call", {
			url: "https://example.com",
			reader: "trafilatura",
		}, undefined, undefined, { cwd: process.cwd() })).rejects.toThrow(
			"trafilatura CLI not found",
		);
	});

	// -----------------------------------------------------------------------
	// No reader param, no readerPriority = trafilatura only (single reader mode)
	// -----------------------------------------------------------------------

	it("uses Trafilatura by default when no reader param and no readerPriority", async () => {
		execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, callback: Function) => {
			callback(null, { stdout: "# Example Title\n\nExtracted content", stderr: "" });
		});

		const tools: Record<string, any> = {};
		const extension = (await import("../extensions/search-hub.js")).default;
		extension(fakeToolRegistration(tools));

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

	it("throws without fallback when default trafilatura fails and no readerPriority", async () => {
		execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, callback: Function) => {
			const err = new Error("spawn ENOENT");
			(err as any).code = "ENOENT";
			callback(err, null);
		});

		const tools: Record<string, any> = {};
		const extension = (await import("../extensions/search-hub.js")).default;
		extension(fakeToolRegistration(tools));

		await expect(tools.web_read.execute("call", {
			url: "https://example.com",
		}, undefined, undefined, { cwd: process.cwd() })).rejects.toThrow(
			"trafilatura CLI not found",
		);
	});

	it("explains trafilatura process failures when the CLI exits without output", async () => {
		fetchSpy.mockResolvedValueOnce(new Response("missing", {
			status: 404,
			statusText: "Not Found",
		}));
		execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, callback: Function) => {
			const err = new Error("Command failed: trafilatura -u https://bad.example --markdown --no-comments");
			(err as any).exitCode = 1;
			(err as any).stdout = "";
			(err as any).stderr = "";
			callback(err, null);
		});

		const tools: Record<string, any> = {};
		const extension = (await import("../extensions/search-hub.js")).default;
		extension(fakeToolRegistration(tools));

		await expect(tools.web_read.execute("call", {
			url: "https://bad.example",
		}, undefined, undefined, { cwd: process.cwd() })).rejects.toThrow(
			"trafilatura CLI error (exit 1): no diagnostic output; likely URL download/HTTP/TLS failure or no extractable content; url check: API error (404): missing",
		);
	});

	it("includes fetch error codes in trafilatura URL diagnostics", async () => {
		fetchSpy.mockRejectedValueOnce(Object.assign(new Error("fetch failed"), {
			cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND bad.example" },
		}));
		execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, callback: Function) => {
			const err = new Error("Command failed: trafilatura");
			(err as any).exitCode = 1;
			callback(err, null);
		});

		const tools: Record<string, any> = {};
		const extension = (await import("../extensions/search-hub.js")).default;
		extension(fakeToolRegistration(tools));

		await expect(tools.web_read.execute("call", {
			url: "https://bad.example",
		}, undefined, undefined, { cwd: process.cwd() })).rejects.toThrow(
			"url check failed: fetch failed: ENOTFOUND: getaddrinfo ENOTFOUND bad.example",
		);
	});

	it("explains empty trafilatura extraction separately from CLI failures", async () => {
		fetchSpy.mockResolvedValueOnce(new Response("", {
			status: 200,
			statusText: "OK",
			headers: { "content-type": "text/html" },
		}));
		execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, callback: Function) => {
			callback(null, { stdout: "\n", stderr: "" });
		});

		const tools: Record<string, any> = {};
		const extension = (await import("../extensions/search-hub.js")).default;
		extension(fakeToolRegistration(tools));

		await expect(tools.web_read.execute("call", {
			url: "https://example.com/empty",
		}, undefined, undefined, { cwd: process.cwd() })).rejects.toThrow(
			"url check: reachable (HTTP 200 OK, content-type: text/html)",
		);
	});

	// -----------------------------------------------------------------------
	// readerPriority: first succeeds
	// -----------------------------------------------------------------------

	it("tries readers in readerPriority order and returns first success", async () => {
		fetchSpy.mockRejectedValueOnce(Object.assign(new Error("fetch failed"), {
			cause: { code: "UND_ERR_CONNECT_TIMEOUT", message: "timeout" },
		}));
		execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, callback: Function) => {
			callback(null, { stdout: "# Fallback Title\n\nRecovered content", stderr: "" });
		});

		const configMod = await import("../extensions/config.js");
		configMod.config.readerPriority = ["jina", "trafilatura"];

		const tools: Record<string, any> = {};
		const extension = (await import("../extensions/search-hub.js")).default;
		extension(fakeToolRegistration(tools));

		const result = await tools.web_read.execute("call", {
			url: "https://example.com",
		}, undefined, undefined, { cwd: process.cwd() });

		expect(result.content[0].text).toBe("# Fallback Title\n\nRecovered content");
		expect(result.details).toMatchObject({
			reader: "trafilatura",
			fallbackErrors: [{ reader: "jina", cause: expect.stringContaining("timeout") }],
		});
	});

	it("includes fallbackErrors in details when one reader fails and another succeeds", async () => {
		fetchSpy.mockRejectedValueOnce(new Error("Jina returned 429"));
		execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, callback: Function) => {
			callback(null, { stdout: "# Recovered\n\nContent", stderr: "" });
		});

		const configMod = await import("../extensions/config.js");
		configMod.config.readerPriority = ["jina", "trafilatura"];

		const tools: Record<string, any> = {};
		const extension = (await import("../extensions/search-hub.js")).default;
		extension(fakeToolRegistration(tools));

		const result = await tools.web_read.execute("call", {
			url: "https://example.com/page",
		}, undefined, undefined, { cwd: process.cwd() });

		expect(result.details).toMatchObject({
			reader: "trafilatura",
			fallbackErrors: [{ reader: "jina", cause: expect.stringContaining("Jina returned 429") }],
		});
	});

	// -----------------------------------------------------------------------
	// readerPriority: all fail
	// -----------------------------------------------------------------------

	it("throws aggregated error when all readers in readerPriority fail", async () => {
		fetchSpy.mockRejectedValueOnce(new Error("Jina DNS error"));
		execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, callback: Function) => {
			callback(new Error("trafilatura not installed"), null);
		});

		const configMod = await import("../extensions/config.js");
		configMod.config.readerPriority = ["jina", "trafilatura"];

		const tools: Record<string, any> = {};
		const extension = (await import("../extensions/search-hub.js")).default;
		extension(fakeToolRegistration(tools));

		await expect(tools.web_read.execute("call", {
			url: "https://example.com",
		}, undefined, undefined, { cwd: process.cwd() })).rejects.toThrow(
			"All web readers failed for https://example.com. " +
			"jina: Failed to read https://example.com: Jina DNS error; " +
			"trafilatura: Trafilatura failed for https://example.com: trafilatura CLI error: trafilatura not installed",
		);
	});

	// -----------------------------------------------------------------------
	// readerPriority partial (omits some readers)
	// -----------------------------------------------------------------------

	it("only tries readers listed in readerPriority", async () => {
		fetchSpy.mockRejectedValueOnce(new Error("Sofya 402"));

		const configMod = await import("../extensions/config.js");
		configMod.config.readerPriority = ["sofya"];

		const tools: Record<string, any> = {};
		const extension = (await import("../extensions/search-hub.js")).default;
		extension(fakeToolRegistration(tools));

		await expect(tools.web_read.execute("call", {
			url: "https://example.com",
		}, undefined, undefined, { cwd: process.cwd() })).rejects.toThrow(
			"Sofya 402",
		);
		// fetch only called once (only sofya attempted)
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	// -----------------------------------------------------------------------
	// Explicit reader param overrides readerPriority (no fallback)
	// -----------------------------------------------------------------------

	it("explicit reader param overrides readerPriority with no fallback", async () => {
		fetchSpy.mockRejectedValueOnce(new Error("Jina rate limited"));

		const configMod = await import("../extensions/config.js");
		configMod.config.readerPriority = ["trafilatura", "sofya", "jina"];

		const tools: Record<string, any> = {};
		const extension = (await import("../extensions/search-hub.js")).default;
		extension(fakeToolRegistration(tools));

		await expect(tools.web_read.execute("call", {
			url: "https://example.com",
			reader: "jina",
		}, undefined, undefined, { cwd: process.cwd() })).rejects.toThrow("Jina rate limited");

		// Only jina was tried, despite readerPriority including trafilatura and sofya
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	// -----------------------------------------------------------------------
	// Reader param = sofya (explicit, no fallback)
	// -----------------------------------------------------------------------

	it("uses sofya when reader=sofya param passed (no fallback)", async () => {
		fetchSpy.mockResolvedValueOnce(new Response(
			JSON.stringify({ results: [{ title: "S", url: "https://example.com", content: "# Sofya\nContent" }] }),
			{ status: 200, headers: { "content-type": "application/json" } },
		));

		const configMod = await import("../extensions/config.js");
		configMod.config.backends = { sofya: { enabled: true, apiKey: "test-key" } };

		const tools: Record<string, any> = {};
		const extension = (await import("../extensions/search-hub.js")).default;
		extension(fakeToolRegistration(tools));

		const result = await tools.web_read.execute("call", {
			url: "https://example.com",
			reader: "sofya",
		}, undefined, undefined, { cwd: process.cwd() });

		expect(result.details).toMatchObject({ reader: "sofya" });
		expect(result.content[0].text).toContain("# Sofya");
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
