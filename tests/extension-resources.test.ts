import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	keyHint: () => "expand",
}));
vi.mock("@earendil-works/pi-ai", () => ({
	StringEnum: (values: string[]) => ({ enum: values }),
}));
vi.mock("@earendil-works/pi-tui", () => ({
	Text: class Text {
		constructor(public text: string) {}
	},
}));

import webSearchExtension from "../extensions/web-search.js";
import webReadExtension from "../extensions/web-read.js";

function fakeExtensionApi() {
	const tools: string[] = [];
	const commands: string[] = [];
	const events: string[] = [];
	const api = {
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		on(event: string) {
			events.push(event);
		},
	};
	return { api, tools, commands, events };
}

describe("independent Pi extension resources", () => {
	it("web-search registers only search functionality", () => {
		const registry = fakeExtensionApi();
		webSearchExtension(registry.api as never);

		expect(registry.tools).toEqual(["web_search"]);
		expect(registry.commands).toEqual(["search-setup", "search-status"]);
		expect(registry.events).toContain("session_start");
	});

	it("web-read registers only the reader tool", () => {
		const registry = fakeExtensionApi();
		webReadExtension(registry.api as never);

		expect(registry.tools).toEqual(["web_read"]);
		expect(registry.commands).toEqual([]);
		expect(registry.events).toEqual([]);
	});

	it("declares both resources and leaves activation out of search.json", () => {
		const root = process.cwd();
		const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const exampleConfig = JSON.parse(readFileSync(join(root, "search.json.example"), "utf8"));

		expect(packageJson.pi.extensions).toEqual([
			"./extensions/web-search.ts",
			"./extensions/web-read.ts",
		]);
		expect(exampleConfig).not.toHaveProperty("enableWebSearch");
		expect(exampleConfig).not.toHaveProperty("enableWebRead");
	});
});
