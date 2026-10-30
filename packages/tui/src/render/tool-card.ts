import type { TspText } from "@oh-my-pi/pi-wire";
import { Text } from "../components/text";
import { compactText, rowsText, styledSpans } from "../native/spans";
import { sameItems } from "../native/memo";
import type { DescribeContext, NativeChild, NativeNode } from "../native/node";
import type { Theme } from "../theme/theme";
import type { Component } from "../tui";
import { visibleWidth } from "../utils";
import { wrapGuidedLine, wrapPrefixedLine } from "./hanging-wrap";
import {
	CachedOutputBlock,
	describeOutputBlock,
	markFramedBlockComponent,
	type NativeOutputBlockSection,
	outputBlockContentWidth,
	outputBlockHeaderWidth,
	type OutputBlockOptions,
} from "./output-block";
import { renderFittedStatusLine, type StatusLineOptions, statusLineSpans } from "./status-line";
import type { State } from "./types";

/** Lifecycle distinctions shared by tool call and result cards. */
export type ToolCardPhase = "pending" | "running" | "partial" | "success" | "warning" | "error" | "info";

/** Fixed card topology. Framed cards own their border; plain cards are flush: a header row over indented body rows. */
export type ToolCardVariant = "framed" | "plain";

/** Body indent of flush (plain) cards, in columns. */
export const FLUSH_BODY_INDENT = 2;

/** Lazily rendered slot content. Components retain their own width caches. */
export type ToolCardContent = readonly string[] | Component | ((width: number) => readonly string[] | Component);

/** A labeled body section in a tool card. */
export interface ToolCardSection {
	label?: string;
	content: ToolCardContent;
	separator?: boolean;
}

/**
 * Snapshot returned by a ToolCard builder on each render. Every card's header
 * is a status line; framed cards draw `footerMeta` in the bottom border, flush
 * cards append it to the header row.
 */
export interface ToolCardSnapshot {
	status: StatusLineOptions;
	footerMeta?: string;
	phase?: ToolCardPhase;
	body?: ToolCardContent;
	sections?: readonly ToolCardSection[];
	footer?: ToolCardContent;
	contentPaddingLeft?: number;
	contentPaddingRight?: number;
}

/** Width information supplied to a ToolCard's lazy snapshot builder. */
export interface ToolCardBuildContext {
	width: number;
	/** Inner width: inside the frame's borders and padding, or after the flush body indent. */
	contentWidth: number;
	/** Compute an inner width when this snapshot opts into custom frame padding. */
	contentWidthFor(contentPaddingLeft?: number, contentPaddingRight?: number): number;
}

/** Construction options whose topology remains fixed for a card's lifetime. */
export interface ToolCardOptions {
	variant: ToolCardVariant;
	ignoreTight?: boolean;
	onInvalidate?: () => void;
	/**
	 * Drop builder-owned memos the next build recomputes. Called by
	 * {@link ToolCard.releaseRenderCaches}, which never calls `onInvalidate`.
	 */
	onReleaseRenderCaches?: () => void;
	onDispose?: () => void;
}

/** Map transcript lifecycle terminology onto the output frame's visual states. */
export function toolCardState(phase: ToolCardPhase | undefined): State | undefined {
	if (phase === "partial") return "pending";
	if (phase === "info") return undefined;
	return phase;
}

/**
 * Flush card rows: a long header hangs at the body column so its trailing
 * facts stay visible; body rows indent {@link FLUSH_BODY_INDENT} and wrap
 * under their own tree guides.
 */
export function layoutFlushCard(header: string, rows: readonly string[], width: number, theme: Theme): string[] {
	const indent = " ".repeat(FLUSH_BODY_INDENT);
	const contentWidth = Math.max(1, width - FLUSH_BODY_INDENT);
	const lines = wrapPrefixedLine("", indent, header, width);
	for (const row of rows) {
		for (const line of row.split("\n")) {
			for (const wrapped of wrapGuidedLine(line, contentWidth, theme)) lines.push(`${indent}${wrapped}`);
		}
	}
	return lines;
}

function isRenderedLines(value: readonly string[] | Component): value is readonly string[] {
	return Array.isArray(value);
}

/** Last description of a card, reused while the snapshot's inputs are unchanged. */
interface NativeCardMemo {
	head: string;
	phase: ToolCardPhase | undefined;
	/** Per slot: label plus resolved content (component or rows array) and its described child. */
	slots: readonly {
		label: string | undefined;
		separator: boolean;
		content: readonly string[] | Component;
		child: NativeChild;
	}[];
	node: NativeNode;
}

function resolveContent(content: ToolCardContent, width: number): { lines: readonly string[]; component?: Component } {
	const resolved = typeof content === "function" ? content(width) : content;
	if (isRenderedLines(resolved)) return { lines: resolved };
	return { lines: resolved.render(width), component: resolved };
}

/**
 * Cached tool-card layout with lazy body/section/footer children. The builder
 * may read mutable streaming state at render time; unchanged snapshots retain
 * their rendered array identity through CachedOutputBlock or Text.
 */
export class ToolCard implements Component {
	readonly #theme: Theme;
	readonly #options: ToolCardOptions;
	readonly #build: (context: ToolCardBuildContext) => ToolCardSnapshot;
	readonly #block = new CachedOutputBlock();
	#lastBlockOptions?: OutputBlockOptions;
	#plainText: Text;
	#plainKey = "";
	#renderedChildren: Component[] = [];
	#disposed = false;
	#native: NativeCardMemo | undefined;

	constructor(theme: Theme, options: ToolCardOptions, build: (context: ToolCardBuildContext) => ToolCardSnapshot) {
		this.#theme = theme;
		this.#options = options;
		this.#build = build;
		this.#plainText = new Text("", 0, 0);
		this.#plainText.setIgnoreTight(options.ignoreTight ?? true);
		if (options.variant === "framed") markFramedBlockComponent(this);
	}

	render(width: number): readonly string[] {
		const defaultContentWidth =
			this.#options.variant === "framed" ? outputBlockContentWidth(width) : Math.max(1, width - FLUSH_BODY_INDENT);
		const snapshot = this.#build({
			width,
			contentWidth: defaultContentWidth,
			contentWidthFor: (contentPaddingLeft?: number, contentPaddingRight?: number) =>
				this.#options.variant === "framed"
					? outputBlockContentWidth(width, contentPaddingLeft, contentPaddingRight)
					: defaultContentWidth,
		});
		const contentWidth =
			this.#options.variant === "framed"
				? outputBlockContentWidth(width, snapshot.contentPaddingLeft, snapshot.contentPaddingRight)
				: defaultContentWidth;

		const previousChildren = this.#renderedChildren;
		const nextChildren: Component[] = [];
		const nextChildSet = new Set<Component>();
		const retainChild = (component: Component | undefined): void => {
			if (!component || nextChildSet.has(component)) return;
			nextChildSet.add(component);
			nextChildren.push(component);
		};
		const sections: Array<{ label?: string; lines: readonly string[]; separator?: boolean }> = [];
		if (snapshot.body) {
			const body = resolveContent(snapshot.body, contentWidth);
			sections.push({ lines: body.lines });
			retainChild(body.component);
		}
		for (const section of snapshot.sections ?? []) {
			const resolved = resolveContent(section.content, contentWidth);
			sections.push({ label: section.label, lines: resolved.lines, separator: section.separator });
			retainChild(resolved.component);
		}
		if (snapshot.footer) {
			const footer = resolveContent(snapshot.footer, contentWidth);
			sections.push({ lines: footer.lines, separator: sections.length > 0 });
			retainChild(footer.component);
		}
		for (const previousChild of previousChildren) {
			if (!nextChildSet.has(previousChild)) previousChild.dispose?.();
		}
		this.#renderedChildren = nextChildren;

		const state = toolCardState(snapshot.phase);
		// Framed headers never animate: native-scrollback commits are prefix-only,
		// so a spinner in the top border would pin the commit boundary above the body.
		// Either way the header keeps to one row: the top border, or the flush row
		// (which `layoutFlushCard` wraps at the body indent) beside any footer facts.
		const header =
			this.#options.variant === "framed"
				? renderFittedStatusLine(
						{ ...snapshot.status, spinnerFrame: undefined },
						this.#theme,
						outputBlockHeaderWidth(width, this.#theme),
					)
				: renderFittedStatusLine(
						snapshot.status,
						this.#theme,
						width - FLUSH_BODY_INDENT - (snapshot.footerMeta ? visibleWidth(snapshot.footerMeta) + 1 : 0),
					);
		if (this.#options.variant === "framed") {
			const previousOptions = this.#lastBlockOptions;
			const previousSections = previousOptions?.sections;
			const sectionsStable =
				previousSections?.length === sections.length &&
				sections.every((section, index) => {
					const previous = previousSections[index];
					return (
						previous?.label === section.label &&
						previous.lines === section.lines &&
						previous.separator === section.separator
					);
				});
			const reusableOptions =
				previousOptions?.width === width &&
				previousOptions.header === header &&
				previousOptions.footerMeta === snapshot.footerMeta &&
				previousOptions.state === state &&
				previousOptions.contentPaddingLeft === snapshot.contentPaddingLeft &&
				previousOptions.contentPaddingRight === snapshot.contentPaddingRight &&
				sectionsStable
					? previousOptions
					: undefined;
			const blockOptions: OutputBlockOptions = reusableOptions ?? {
				header,
				footerMeta: snapshot.footerMeta,
				state,
				sections,
				width,
				contentPaddingLeft: snapshot.contentPaddingLeft,
				contentPaddingRight: snapshot.contentPaddingRight,
			};
			this.#lastBlockOptions = blockOptions;
			return this.#block.render(blockOptions, this.#theme);
		}

		const rows: string[] = [];
		for (const section of sections) {
			if (section.label) rows.push(this.#theme.fg("dim", section.label));
			rows.push(...section.lines);
		}
		const text = layoutFlushCard(
			snapshot.footerMeta ? `${header} ${this.#theme.fg("dim", snapshot.footerMeta)}` : header,
			rows,
			width,
			this.#theme,
		).join("\n");
		const key = `${width}:${text.length}:${Bun.hash(text).toString(36)}`;
		if (key !== this.#plainKey) {
			this.#plainKey = key;
			this.#plainText.setText(text);
		}
		return this.#plainText.render(width);
	}

	/**
	 * A `card` (flat `inset` for plain cards) with the state's tone and status
	 * chip, head from the header/status line, and body slots: components as
	 * children, pre-rendered rows as unwrapped text, labelled sections as
	 * `section`s. The builder gets the surface width as its only width.
	 */
	describe(cx: DescribeContext): NativeNode {
		const snapshot = this.#build({ width: cx.cols, contentWidth: cx.cols, contentWidthFor: () => cx.cols });
		const previous = this.#native;
		const slotInputs: { label: string | undefined; separator: boolean; content: ToolCardContent }[] = [];
		if (snapshot.body) slotInputs.push({ label: undefined, separator: false, content: snapshot.body });
		for (const section of snapshot.sections ?? []) {
			slotInputs.push({ label: section.label, separator: section.separator === true, content: section.content });
		}
		if (snapshot.footer)
			slotInputs.push({ label: undefined, separator: slotInputs.length > 0, content: snapshot.footer });
		if (snapshot.footerMeta) slotInputs.push({ label: undefined, separator: false, content: [snapshot.footerMeta] });

		const nextChildren: Component[] = [];
		const slots = slotInputs.map((input, index) => {
			const content = typeof input.content === "function" ? input.content(cx.cols) : input.content;
			const prior = previous?.slots[index];
			let child: NativeChild;
			if (isRenderedLines(content)) {
				child =
					prior !== undefined && isRenderedLines(prior.content) && sameItems(prior.content, content)
						? prior.child
						: rowsText(content);
			} else {
				child = content;
				if (!nextChildren.includes(content)) nextChildren.push(content);
			}
			return { label: input.label, separator: input.separator, content, child };
		});
		for (const child of this.#renderedChildren) {
			if (!nextChildren.includes(child)) child.dispose?.();
		}
		this.#renderedChildren = nextChildren;

		const head = JSON.stringify(snapshot.status);
		if (
			previous !== undefined &&
			previous.head === head &&
			previous.phase === snapshot.phase &&
			previous.slots.length === slots.length &&
			slots.every((slot, index) => {
				const prior = previous.slots[index]!;
				return prior.label === slot.label && prior.separator === slot.separator && prior.child === slot.child;
			})
		) {
			return previous.node;
		}

		const headSpans: TspText = statusLineSpans(snapshot.status, this.#theme);
		const sections: NativeOutputBlockSection[] = slots.map((slot, index) => ({
			label: slot.label === undefined ? undefined : compactText(styledSpans(slot.label)),
			separator: slot.separator,
			body: [slot.child],
			key: String(index),
		}));
		const state = toolCardState(snapshot.phase);
		const plain = this.#options.variant === "plain";
		const described = describeOutputBlock({
			head: headSpans,
			state,
			role: "omp.tool",
			sections,
			inset: plain || undefined,
		});
		this.#native = {
			head,
			phase: snapshot.phase,
			slots,
			node: described,
		};
		return described;
	}

	get debugChildren(): readonly Component[] {
		return this.#renderedChildren;
	}

	get wantsKeyRelease(): boolean {
		return this.#renderedChildren.some(child => child.wantsKeyRelease === true);
	}

	handleInput(data: string): void {
		for (const child of this.#renderedChildren) child.handleInput?.(data);
	}

	setIgnoreTight(ignore: boolean): void {
		this.#options.ignoreTight = ignore;
		this.#plainText.setIgnoreTight(ignore);
		for (const child of this.#renderedChildren) child.setIgnoreTight?.(ignore);
		this.invalidate();
	}

	invalidate(): void {
		this.#native = undefined;
		this.#block.invalidate();
		this.#lastBlockOptions = undefined;
		this.#plainKey = "";
		this.#plainText.invalidate();
		for (const child of this.#renderedChildren) child.invalidate?.();
		this.#options.onInvalidate?.();
	}

	releaseRenderCaches(): void {
		this.#block.invalidate();
		this.#lastBlockOptions = undefined;
		this.#plainKey = "";
		this.#plainText.setText("");
		this.#plainText.releaseRenderCaches();
		for (const child of this.#renderedChildren) child.releaseRenderCaches?.();
		this.#options.onReleaseRenderCaches?.();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const child of this.#renderedChildren) child.dispose?.();
		this.#options.onDispose?.();
		this.#renderedChildren = [];
	}
}

/** Construct a lazy framed tool card. */
export function framedToolCard(
	theme: Theme,
	build: (context: ToolCardBuildContext) => ToolCardSnapshot,
	options: Omit<ToolCardOptions, "variant"> = {},
): ToolCard {
	return new ToolCard(theme, { ...options, variant: "framed" }, build);
}

/** Construct a lazy inline tool card, optionally state-tinted. */
export function plainToolCard(
	theme: Theme,
	build: (context: ToolCardBuildContext) => ToolCardSnapshot,
	options: Omit<ToolCardOptions, "variant"> = {},
): ToolCard {
	return new ToolCard(theme, { ...options, variant: "plain" }, build);
}
