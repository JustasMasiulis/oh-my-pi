import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { applyHyperlinkSetting } from "../src/render/hyperlink";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { globToolRenderer } from "@oh-my-pi/pi-tui/tools/glob";
import { PREVIEW_LIMITS } from "../src/render/render-utils";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

afterEach(() => {
	applyHyperlinkSetting("auto");
});

describe("globToolRenderer", () => {
	it("starts glob output at the tool column and avoids accent-colored success headers", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				fileCount: 2,
				files: ["src/a.ts", "src/b.ts"],
			},
		};

		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/**/*.ts" })
			.render(240);
		const plainLines = sanitizeText(renderedLines.join("\n")).split("\n");

		// Same left edge as every other tool row (read, todo, framed cards).
		expect(plainLines[0]).not.toStartWith(" ");
		expect(renderedLines[0]).not.toContain(uiTheme.fg("accent", uiTheme.symbol("icon.search")));
		expect(renderedLines[0]).not.toContain(uiTheme.fg("accent", "Find"));
	});

	it("reveals a lone hidden file only when it draws as one unclipped row", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const cap = PREVIEW_LIMITS.COLLAPSED_ITEMS;
		const render = (last: string, width: number) => {
			const files = [...Array.from({ length: cap }, (_, i) => `src/f${i}.ts`), last];
			const result = { content: [{ type: "text", text: "" }], details: { fileCount: files.length, files } };
			return sanitizeText(
				globToolRenderer
					.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, { paths: "src" })
					.render(width)
					.join("\n"),
			);
		};
		expect(render("src/last.ts", 80)).toContain("src/last.ts");
		expect(render("src/last.ts", 80)).not.toContain("1 more file");
		const long = `src/${"deep/".repeat(30)}last.ts`;
		expect(render(long, 80)).toContain("1 more file");
	});

	it("renders a timed-out empty scan as incomplete instead of a definitive no-files claim", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		// `truncated` with zero files only happens on the timeout path — the
		// scan died mid-walk, so "No files found" would be a false claim.
		const result = {
			content: [{ type: "text", text: "Glob timed out after 5s before finding any matches" }],
			details: {
				fileCount: 0,
				files: [],
				truncated: true,
			},
		};

		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "~/.cache/*" })
			.render(240);
		const plain = sanitizeText(renderedLines.join("\n"));

		expect(plain).toContain(`0 files${uiTheme.sep.dot}timed out`);
	});

	it("distinguishes a timed-out partial listing from a result-limit truncation", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		// Both are `truncated`, but only one means the scan died. Showing a
		// dead scan as "truncated" invites a blind retry with a bigger limit.
		const timedOut = {
			content: [{ type: "text", text: "src/a.ts\nglob timed out after 5s; returning 2 partial matches" }],
			details: {
				fileCount: 2,
				files: ["src/a.ts", "src/b.ts"],
				truncated: true,
				timedOut: true,
			},
		};
		const limitOnly = {
			content: [{ type: "text", text: "src/a.ts" }],
			details: {
				fileCount: 2,
				files: ["src/a.ts", "src/b.ts"],
				truncated: true,
				resultLimitReached: 2,
			},
		};

		const render = (result: unknown): string =>
			sanitizeText(
				globToolRenderer
					.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/**/*.ts" })
					.render(240)
					.join("\n"),
			);

		expect(render(timedOut)).toContain("timed out");
		const limited = render(limitOnly);
		expect(limited).toContain("truncated");
		expect(limited).not.toContain("timed out");
	});

	it("renders a genuinely empty result as 0 files without a timeout note", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "No files found matching pattern" }],
			details: {
				fileCount: 0,
				files: [],
				truncated: false,
			},
		};

		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/*.zig" })
			.render(240);
		const plain = sanitizeText(renderedLines.join("\n"));

		expect(plain).toContain("0 files");
		expect(plain).not.toContain("timed out");
	});

	it("keeps a long multi-path header on one row and lists each missing path on its own row", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const found = "C:/Program Files (x86)/Windows Kits/10/Include/10.0.28000.0/um/winternl.h";
		const missing = [
			"C:/Program Files/Microsoft Visual Studio/*/*/VC/Auxiliary/Build/vcvars*.bat",
			"C:/Program Files/Microsoft Visual Studio/*/VC/Auxiliary/Build/vcvars*.bat",
		];
		const result = {
			content: [{ type: "text", text: found }],
			details: { fileCount: 1, files: [found], missingPaths: missing },
		};

		const render = (width: number) =>
			sanitizeText(
				globToolRenderer
					.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, {
						path: ["C:/Program Files (x86)/Windows Kits/10/Include/*/um/winternl.h", ...missing].join(";"),
					})
					.render(width)
					.join("\n"),
			)
				.split("\n")
				.map(line => line.trimEnd());

		// The `;`-separated scope reads as a list.
		expect(render(400)[0]).toBe(
			`${uiTheme.status.success} Glob: C:/Program Files (x86)/Windows Kits/10/Include/*/um/winternl.h, ${missing.join(", ")} 1 file`,
		);
		// Too wide for the row: the scope is cut in its middle so the facts stay on the header row.
		const narrow = render(120);
		expect(narrow[0]).toStartWith(`${uiTheme.status.success} Glob: C:/Program Files (x86)/`);
		expect(narrow[0]).toContain(uiTheme.format.ellipsis);
		expect(narrow[0]).toEndWith("vcvars*.bat 1 file");
		expect(narrow.slice(2)).toEqual(missing.map(item => `  skipped missing: ${item}`));
	});

	it("keeps raw control-byte file targets while displaying sanitized labels in terminal and native results", async () => {
		applyHyperlinkSetting("always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const control = "\x1b[?1049h";
		const cwd = `/tmp/glob${control}-project`;
		const file = `src/fi${control}xture.ts`;
		const rawDetails = { cwd, fileCount: 1, files: [file] };
		const result = {
			content: [{ type: "text", text: "" }],
			details: { cwd: sanitizeText(cwd), fileCount: 1, files: [sanitizeText(file)] },
		};
		const options = { expanded: true, isPartial: false, renderContext: { rawDetails } };
		const rendered = globToolRenderer.renderResult(result, options, theme!).render(240).join("\n");
		const uri = url.pathToFileURL(path.resolve(cwd, file)).href;
		expect(extractLinkUris(rendered)).toEqual([uri]);
		expect(rendered).not.toContain(control);
		expect(sanitizeText(rendered)).toContain("fixture.ts");

		const native = globToolRenderer.describeResult(result, options);
		const serialized = JSON.stringify(native);
		expect(serialized).toContain(uri);
		expect(serialized).not.toContain(control);
		expect(serialized).toContain("fixture.ts");
	});
});
