/**
 * `omp gallery` — render every built-in tool's renderer across its lifecycle.
 *
 * For each tool with a registered renderer, the gallery drives a real
 * {@link ToolExecutionComponent} through four states — streaming arguments,
 * arguments complete (in progress), success, and failure — and prints the
 * rendered output to stdout. Transcript messages, live-window widgets, composer
 * shapes and status-line segments render alongside as preview sections. It exists for
 * visual QA without having to provoke each state through a live agent session.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import {
	GALLERY_UI,
	type GalleryFixture,
	type GalleryPreviewEntry,
	type GalleryResult,
	galleryFixtures,
	getComposerGalleryEntries,
	getMessageGalleryEntries,
	getSegmentGalleryEntries,
	getWidgetGalleryEntries,
} from "./gallery-fixtures";
import { captureGalleryScreenshots } from "./gallery-screenshot";

import { cfgColorBlindMode, cfgSymbolPreset, cfgThemeDark, cfgThemeLight } from "../modes/settings";

/** Lifecycle states the gallery renders, in display order. */
export const GALLERY_STATES = ["streaming", "progress", "success", "error"] as const;
export type GalleryState = (typeof GALLERY_STATES)[number];

/** User-facing labels printed above each rendered lifecycle state. */
export const GALLERY_STATE_LABELS: Record<GalleryState, string> = {
	streaming: "streaming args",
	progress: "in progress",
	success: "done",
	error: "failed",
};

const GALLERY_STATE_ALIASES: Record<string, GalleryState> = {
	streaming: "streaming",
	"streaming args": "streaming",
	progress: "progress",
	"in progress": "progress",
	success: "success",
	done: "success",
	error: "error",
	failed: "error",
};

/** Accepted `--state` tokens, including legacy lifecycle names and displayed labels. */
export const GALLERY_STATE_TOKENS = Object.keys(GALLERY_STATE_ALIASES);

/** Gallery surfaces in stable product order. */
export const GALLERY_SURFACES = ["tool", "message", "widget", "composer", "segment"] as const;
export type GallerySurface = (typeof GALLERY_SURFACES)[number];
export const GALLERY_SURFACE_TOKENS = [...GALLERY_SURFACES, "all"] as const;

/** Expand user-provided surface tokens while preserving product order. */
export function parseGallerySurfaces(surfaces: readonly string[] | undefined): GallerySurface[] | undefined {
	if (!surfaces || surfaces.length === 0) return undefined;
	const requested = new Set<GallerySurface>();
	for (const raw of surfaces) {
		const token = raw.trim().toLowerCase();
		if (token === "all") {
			for (const surface of GALLERY_SURFACES) requested.add(surface);
			continue;
		}
		if (!GALLERY_SURFACES.includes(token as GallerySurface)) {
			throw new Error(`Invalid --surface '${raw}'. Valid values: ${GALLERY_SURFACE_TOKENS.join(", ")}`);
		}
		requested.add(token as GallerySurface);
	}
	return GALLERY_SURFACES.filter(surface => requested.has(surface));
}

/** Normalize user-provided `--state` tokens to the internal gallery lifecycle states. */
export function parseGalleryStates(states: readonly string[] | undefined): GalleryState[] | undefined {
	if (!states || states.length === 0) return undefined;
	const parsed: GalleryState[] = [];
	for (const raw of states) {
		const state = GALLERY_STATE_ALIASES[raw.trim().toLowerCase()];
		if (!state) {
			throw new Error(`Invalid --state '${raw}'. Valid values: ${GALLERY_STATE_TOKENS.join(", ")}`);
		}
		if (!parsed.includes(state)) parsed.push(state);
	}
	return parsed;
}

export interface GalleryCommandArgs {
	/** Render width in columns (defaults to terminal width, clamped). */
	width?: number;
	/** Restrict rendering to selected surface types (defaults to all). */
	surfaces?: GallerySurface[];
	/** Restrict to a single tool name. */
	tool?: string;
	/** Restrict to a single transcript message kind. */
	message?: string;
	/** Restrict to a single live-window widget. */
	widget?: string;
	/** Restrict to a single composer shape. */
	composer?: string;
	/** Restrict to a single status-line segment. */
	segment?: string;
	/** Restrict to specific lifecycle states. */
	states?: GalleryState[];
	/** Render the expanded variant of each renderer. */
	expanded?: boolean;
	/** Strip ANSI styling from the output (useful when redirecting to a file). */
	plain?: boolean;
	/** Capture the rendered gallery as PNG screenshot(s) via VHS instead of printing ANSI. */
	screenshot?: boolean;
	/** Screenshot output path (single image) or base path (suffixed when split across images). */
	out?: string;
	/** Font family for screenshots (must be installed; Nerd Font recommended for icon glyphs). */
	font?: string;
	/** Font size in points for screenshots. */
	fontSize?: number;
}

/** One rendered gallery section, as ANSI lines: a leading blank, the section rule, then each variant. */
export interface GallerySection {
	heading: string;
	lines: string[];
}

const GENERIC_ERROR: GalleryResult = {
	content: [{ type: "text", text: "Error: operation failed" }],
	isError: true,
};

/**
 * Build the fake `AgentTool` the component needs for its label, edit mode, and —
 * for `customRendered` fixtures — the renderer functions that route it through
 * the same custom-tool branch production uses (see {@link GalleryFixture}).
 */
function fakeToolFor(name: string, fixture: GalleryFixture | undefined): AgentTool | undefined {
	if (!fixture?.label && !fixture?.editMode && !fixture?.customRendered) return undefined;
	const tool: Record<string, unknown> = { name, label: fixture.label ?? name, mode: fixture.editMode };
	if (fixture.customRendered) {
		const renderer = toolRenderers[fixture.renderer ?? name] as
			| { renderCall?: unknown; renderResult?: unknown; mergeCallAndResult?: unknown; inline?: unknown }
			| undefined;
		if (renderer) {
			tool.renderCall = renderer.renderCall;
			tool.renderResult = renderer.renderResult;
			tool.mergeCallAndResult = renderer.mergeCallAndResult;
			tool.inline = renderer.inline;
		}
	}
	return tool as unknown as AgentTool;
}

/** The curated fixture for a tool, or a generic one for registry tools lacking sample data. */
export function resolveFixture(name: string): GalleryFixture {
	return (
		galleryFixtures[name] ??
		({
			args: { note: `sample ${name} call` },
			result: { content: [{ type: "text", text: `${name} completed` }] },
		} satisfies GalleryFixture)
	);
}

/**
 * Render a single tool/state pair to lines. Builds a fresh component, drives it
 * to the requested state, settles any async edit preview, then snapshots the
 * render and stops all animation timers.
 */
export async function renderGalleryState(
	name: string,
	fixture: GalleryFixture,
	state: GalleryState,
	width: number,
	expanded = false,
): Promise<readonly string[]> {
	if (fixture.renderState) {
		return await fixture.renderState(state, width, expanded);
	}

	// A non-customRendered fixture may borrow another tool's built-in renderer
	// (e.g. `edit_delete` → `edit`): drive the component under that real tool
	// name so the sample exercises the exact production branch, not the
	// custom-tool one.
	const componentName = fixture.customRendered ? name : (fixture.renderer ?? name);
	const tool = fakeToolFor(componentName, fixture);
	const streamingArgs = state === "streaming" ? (fixture.streamingArgs ?? fixture.args) : fixture.args;
	const component = new ToolExecutionComponent(
		componentName,
		streamingArgs,
		{ showImages: false, useBuiltInRenderer: !fixture.customRendered },
		tool,
		GALLERY_UI,
		getProjectDir(),
	);
	component.setExpanded(expanded);

	if (state !== "streaming") {
		component.setArgsComplete();
		component.setExecutionStarted();
	}
	if (state === "success") {
		component.updateResult(fixture.result, false);
	} else if (state === "error") {
		component.updateResult(fixture.errorResult ?? GENERIC_ERROR, false);
	}

	// Edit-like renderers compute their diff preview off the render path; wait
	// for it to settle so the snapshot is deterministic instead of racing a tick.
	// Static fixtures have no live batch source, so bound the wait tightly.
	await component.whenPreviewSettled(50);

	const lines = component.render(width);
	component.stopAnimation();
	return lines;
}

function resolveWidth(requested: number | undefined): number {
	const fallback = process.stdout.columns ?? 100;
	const width = requested ?? fallback;
	return Math.max(40, Math.min(200, width));
}

function sectionRule(label: string, width: number): string {
	const rule = theme.boxSharp.horizontal;
	const prefix = `${rule.repeat(2)} ${label} `;
	const fill = Math.max(0, width - visibleWidth(prefix));
	return theme.fg("accent", theme.bold(`${prefix}${rule.repeat(fill)}`));
}

/** One entry per tool (every registry renderer plus every fixture, sorted), one variant per lifecycle state. */
function toolGalleryEntries(states: readonly GalleryState[]): GalleryPreviewEntry[] {
	const names = new Set([...Object.keys(toolRenderers), ...Object.keys(galleryFixtures)]);
	return [...names].sort().map(name => {
		const fixture = resolveFixture(name);
		const heading = fixture.label && fixture.label !== name ? `${name}${theme.sep.dot}${fixture.label}` : name;
		return {
			id: name,
			heading,
			variants: states.map(state => ({
				label: GALLERY_STATE_LABELS[state],
				render: (width, expanded) => renderGalleryState(name, fixture, state, width, expanded),
			})),
		};
	});
}

function surfaceEntries(surface: GallerySurface, states: readonly GalleryState[]): readonly GalleryPreviewEntry[] {
	switch (surface) {
		case "tool":
			return toolGalleryEntries(states);
		case "message":
			return getMessageGalleryEntries();
		case "widget":
			return getWidgetGalleryEntries();
		case "composer":
			return getComposerGalleryEntries();
		case "segment":
			return getSegmentGalleryEntries();
	}
}

/** Surfaces named by `--surface` or implied by an entry filter (`--tool`, `--message`, …); all when neither is given. */
function resolveSurfaces(args: GalleryCommandArgs): GallerySurface[] {
	const selected = GALLERY_SURFACES.filter(surface => args.surfaces?.includes(surface) || args[surface]);
	return selected.length > 0 ? selected : [...GALLERY_SURFACES];
}

/**
 * Render entries into ANSI section blocks. The block layout (leading blank,
 * section rule, then a blank + dim label + body per variant) is shared by the
 * stdout and screenshot paths so both stay identical.
 */
async function renderPreviewSections(
	entries: readonly GalleryPreviewEntry[],
	width: number,
	expanded: boolean,
): Promise<GallerySection[]> {
	const sections: GallerySection[] = [];
	for (const entry of entries) {
		const lines = ["", sectionRule(entry.heading, width)];
		for (const variant of entry.variants) {
			lines.push("", theme.fg("dim", `  ${theme.sep.dot.trim()} ${variant.label}`));
			try {
				for (const line of await variant.render(width, expanded)) lines.push(line);
			} catch (err) {
				lines.push(theme.fg("error", `  render failed: ${String(err)}`));
			}
		}
		sections.push({ heading: entry.heading, lines });
	}
	return sections;
}

/** Build requested sections in the fixed tool → message → widget → composer → segment order. */
export async function renderGallerySurfaceSections(
	args: GalleryCommandArgs,
	width = resolveWidth(args.width),
): Promise<GallerySection[]> {
	const expanded = args.expanded ?? false;
	const states = args.states && args.states.length > 0 ? args.states : GALLERY_STATES;
	const sections: GallerySection[] = [];
	for (const surface of resolveSurfaces(args)) {
		const filter = args[surface];
		const entries = surfaceEntries(surface, states).filter(entry => !filter || entry.id === filter);
		sections.push(...(await renderPreviewSections(entries, width, expanded)));
	}
	return sections;
}

/**
 * Render the gallery: every requested surface's sections printed to stdout —
 * or, with `screenshot`, captured as PNG(s) via VHS.
 */
export async function runGalleryCommand(args: GalleryCommandArgs): Promise<void> {
	const settingsInstance = await Settings.init();
	// Screenshots must carry exact theme RGB regardless of how the invoking
	// terminal advertises its color support, so force truecolor before the theme
	// (and therefore every SGR escape it emits) is built.
	if (args.screenshot) process.env.COLORTERM = "truecolor";
	await initTheme(
		false,
		cfgSymbolPreset.get(settingsInstance),
		cfgColorBlindMode.get(settingsInstance),
		cfgThemeDark.get(settingsInstance),
		cfgThemeLight.get(settingsInstance),
	);

	const width = resolveWidth(args.width);
	for (const surface of resolveSurfaces(args)) {
		const requested = args[surface];
		if (!requested) continue;
		const known = surfaceEntries(surface, GALLERY_STATES).map(entry => entry.id);
		if (!known.includes(requested)) {
			process.stdout.write(`Unknown ${surface} '${requested}'. Known ${surface}s: ${known.join(", ")}\n`);
			return;
		}
	}

	const sections = await renderGallerySurfaceSections(args, width);

	if (args.screenshot) {
		const paths = await captureGalleryScreenshots(sections, {
			width,
			font: args.font,
			fontSize: args.fontSize,
			out: args.out,
		});
		process.stdout.write(`${paths.join("\n")}\n`);
		return;
	}

	const lines = sections.flatMap(section => section.lines);
	lines.push("");
	const text = lines.map(line => (args.plain ? Bun.stripANSI(line) : line)).join("\n");
	process.stdout.write(`${text}\n`);
}
