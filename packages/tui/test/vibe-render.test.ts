/**
 * Contracts: vibe tool renderers.
 *
 * 1. spawn/send render a flush `Vibe: <op target>` card with the message
 *    indented under it.
 * 2. wait/list render the TV wall: one status row per worker, a running
 *    worker's tool-call trace, current tool, and streamed text tail nested
 *    under it; an idle worker its last-activity gist; a settled worker its
 *    turn outcome.
 * 3. Animated content (spinner) re-derives from the shared
 *    mutable options on every paint of the SAME component — spinner ticks
 *    repaint the block without re-invoking renderCall/renderResult.
 * 4. Every emitted line respects the render width (sanitized, truncated).
 */
import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { createVibeToolRenderer, type VibeToolDetails } from "@oh-my-pi/pi-tui/tools/vibe";
import type { VibeScreenSnapshot } from "@oh-my-pi/pi-tui/tools/vibe";

const strip = (lines: readonly string[]): string[] =>
	lines.map(line => line.replace(/\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, ""));

function makeScreen(overrides: Partial<VibeScreenSnapshot> = {}): VibeScreenSnapshot {
	return {
		id: "Anna",
		cli: "fast",
		state: "running",
		turns: 1,
		queued: 0,
		trace: [],
		outputTail: [],
		lastActivityAt: Date.now(),
		...overrides,
	};
}

function renderLines(component: { render(width: number): readonly string[] }, width = 100): string[] {
	return strip(component.render(width));
}

describe("vibe tool renderers", () => {
	let uiTheme: Theme;

	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	});

	it("send call shows the message under the Vibe header", () => {
		const renderer = createVibeToolRenderer("send");
		const component = renderer.renderCall(
			{ session: "Anna", message: "Focus on the API first.\nThen tests." },
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			uiTheme,
		) as { render(width: number): readonly string[] };
		const lines = renderLines(component);

		expect(lines[0]).toContain("Vibe: send Anna");
		expect(lines[1]!.trimEnd()).toBe("  Focus on the API first.");
		expect(lines[2]!.trimEnd()).toBe("  Then tests.");
	});

	it("wait wall spinner re-derives from mutated options on the same component", () => {
		const renderer = createVibeToolRenderer("wait");
		const details: VibeToolDetails = {
			op: "wait",
			screens: [makeScreen({ currentTool: "edit" })],
			wait: { settled: [], stillRunning: ["Anna"], timedOut: false, waiting: true },
		};
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const component = renderer.renderResult({ content: [{ type: "text", text: "" }], details }, options, uiTheme, {
			sessions: ["Anna"],
		}) as { render(width: number): readonly string[] };
		const first = renderLines(component).join("\n");
		options.spinnerFrame = 5;
		const second = renderLines(component).join("\n");
		// Spinner glyphs for frames 0 and 5 differ; a component that baked its
		// lines at build time would render byte-identical output.
		expect(second).not.toBe(first);
	});

	it.each(["wait", "list"] as const)("completed %s walls do not re-emit retired worker rows as time advances", op => {
		let now = 1_800_000_000_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		try {
			const renderer = createVibeToolRenderer(op);
			const details: VibeToolDetails = {
				op,
				screens: ["Anna", "Bob"].map(id =>
					makeScreen({
						id,
						turnStartedAt: now - 60_000,
						turnMessage: "Build the widget",
						trace: ["read(src/widget.ts)", "edit(src/widget.ts)"],
						outputTail: ["Updating the widget"],
					}),
				),
				...(op === "wait" ? { wait: { settled: [], stillRunning: ["Anna", "Bob"], timedOut: true } } : {}),
			};
			const options = { expanded: false, isPartial: false, spinnerFrame: 0 };
			const component = renderer.renderResult({ content: [], details }, options, uiTheme);
			const transcript = new TranscriptContainer();
			transcript.addChild(component);
			transcript.addChild({ render: () => ["director/editor"] });
			const first = transcript.peekFinalizedBatch(100, 10)!;
			expect(strip(first.rows).join("\n")).toContain("Anna");
			transcript.acknowledgeFinalizedBatch(first.id);
			transcript.renderViewport(100, 10, { tick: 0, now });
			for (let tick = 1; tick <= 3; tick++) {
				now += 1000;
				options.spinnerFrame += 1;
				expect(transcript.peekFinalizedBatch(100, 10)).toBeUndefined();
				transcript.renderViewport(100, 10, { tick, now });
			}
		} finally {
			clock.mockRestore();
		}
	});

	it("send result shows the delivery mode with the message under the Vibe header", () => {
		const renderer = createVibeToolRenderer("send");
		const details: VibeToolDetails = {
			op: "send",
			screens: [makeScreen()],
			send: { id: "Anna", mode: "steered" },
		};
		const component = renderer.renderResult(
			{ content: [{ type: "text", text: "ack" }], details },
			{ expanded: false, isPartial: false },
			uiTheme,
			{ session: "Anna", message: "Focus on the API first." },
		) as { render(width: number): readonly string[] };
		const text = renderLines(component).join("\n");

		expect(text).toContain("Vibe: send Anna");
		expect(text).toContain("steered");
		expect(text).toContain("  Focus on the API first.");
	});

	it("wait renders one row per worker: live trace + streamed text, idle gist, settled outcome", () => {
		const renderer = createVibeToolRenderer("wait");
		const details: VibeToolDetails = {
			op: "wait",
			screens: [
				makeScreen({
					id: "Anna",
					cli: "fast",
					state: "running",
					turnStartedAt: Date.now() - 5000,
					turnMessage: "Build the widget",
					trace: ["read(src/foo.ts)", "bash(bun test)"],
					currentTool: "edit",
					lastIntent: "Fixing the parser",
					outputTail: ["The parser now accepts nested arrays"],
					model: "prov/fast-model",
				}),
				makeScreen({ id: "Bob", cli: "good", state: "idle", turns: 2, lastActivity: "turn 2 completed" }),
			],
			wait: {
				settled: [{ id: "Bob", jobId: "Bob-t2", status: "completed" }],
				stillRunning: ["Anna"],
				timedOut: false,
			},
		};
		const component = renderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: true, isPartial: true, spinnerFrame: 2 },
			uiTheme,
			{ sessions: ["Anna", "Bob"] },
		) as { render(width: number): readonly string[] };
		const lines = renderLines(component);
		const text = lines.join("\n");

		// One flush row per worker; its live details nest under it.
		const anna = lines.findIndex((line, index) => index > 0 && line.includes("Anna"));
		expect(lines[anna]).toStartWith("  ");
		expect(lines[anna + 1]).toContain(uiTheme.tree.branch);
		// Badge glyphs are theme-driven (⟦fast⟧ on dark); assert the flavor label itself.
		expect(text).toMatch(/Anna \S?fast/u);
		expect(text).toContain("Build the widget");
		expect(text).toContain("read(src/foo.ts)");
		expect(text).toContain("bash(bun test)");
		expect(text).toContain("edit: Fixing the parser");
		expect(text).toContain("The parser now accepts nested arrays");
		expect(text).toContain("prov/fast-model");
		// Idle worker gist + settled turn outcome.
		expect(text).toContain("Bob");
		expect(text).toContain("turn 2 completed");
		expect(text).toContain("turn completed");
		// Wall header counts what is on air.
		expect(text).toContain("1 on air");
	});

	it("clamps every TV line to the render width", () => {
		const renderer = createVibeToolRenderer("list");
		const details: VibeToolDetails = {
			op: "list",
			screens: [
				makeScreen({
					id: "VeryLongSessionNameForTruncation",
					trace: [`read(${"x".repeat(200)})`],
					outputTail: ["y".repeat(300)],
					currentTool: "bash",
					currentToolArgs: "z".repeat(200),
				}),
			],
		};
		const component = renderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: true, isPartial: false },
			uiTheme,
			{},
		) as { render(width: number): readonly string[] };
		const width = 48;
		for (const line of renderLines(component, width)) {
			expect(line.length).toBeLessThanOrEqual(width);
		}
	});

	it("reports killed sessions left off the wall as a header count, with or without live screens", () => {
		const renderer = createVibeToolRenderer("list");
		const render = (details: VibeToolDetails) =>
			renderLines(
				renderer.renderResult(
					{ content: [{ type: "text", text: "" }], details },
					{ expanded: false, isPartial: false },
					uiTheme,
					{},
				) as { render(width: number): readonly string[] },
			);

		const withLive = render({
			op: "list",
			screens: [makeScreen({ id: "Live" })],
			hiddenKilled: ["GoneA", "GoneB", "GoneC"],
		});
		expect(withLive[0]).toContain("3 killed hidden");
		expect(withLive.join("\n")).not.toContain("GoneA");

		const onlyKilled = render({ op: "list", screens: [], hiddenKilled: ["A", "B"] });
		expect(onlyKilled.join("\n")).toContain("0 sessions");
		expect(onlyKilled.join("\n")).toContain("2 killed hidden");
	});
});
