import { beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { PREVIEW_LINES } from "@oh-my-pi/pi-tui/chat/execution-shared";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	setThemeInstance(dark!);
});

function renderSettled(lineCount: number): string {
	const lines = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`);
	const component = new BashExecutionComponent("seq", ui);
	// A trailing newline, as nearly every command prints.
	component.setComplete(0, false, { output: `${lines.join("\n")}\n` });
	const rendered = component
		.render(80)
		.map(row => Bun.stripANSI(row).trimEnd())
		.join("\n");
	component.dispose();
	return rendered;
}

describe("settled bash run preview", () => {
	it("shows the one line past the cap instead of a `… 1 more line` row", () => {
		const rendered = renderSettled(PREVIEW_LINES + 1);
		expect(rendered).toContain("line 1\n");
		expect(rendered).toContain(`line ${PREVIEW_LINES + 1}`);
		expect(rendered).not.toContain("more line");
	});

	it("counts hidden lines without the empty line a trailing newline opens", () => {
		const rendered = renderSettled(PREVIEW_LINES + 2);
		expect(rendered).not.toContain("line 2\n");
		expect(rendered).toContain(`line ${PREVIEW_LINES + 2}`);
		expect(rendered).toContain("2 more lines");
	});
});
