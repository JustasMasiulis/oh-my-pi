import { Text } from "../components/text";
import { Container } from "../tui";
import {
	type MessageNoticeContext,
	MessageNoticeComponent,
	type MessageNoticeNativePresentation,
	type MessageNoticePresentation,
} from "../chrome/message-notice";
import { theme } from "../theme";
import { cappedRowCount, expandHintLabel, type FoldableRows, foldBody, formatMoreItems } from "../render/render-utils";
import { span, text } from "../native/describe";
import type { NativeNode } from "../native/node";

/** Rule fields shown in rewind notifications. */
export interface NotificationRule {
	name: string;
	description?: string;
	content?: string;
}

/** Collapsed view shows at most this many rules before eliding the rest. */
const MAX_COLLAPSED_RULES = 4;

/** Description lines a lone rule shows while collapsed. */
const SINGLE_COLLAPSED_LINES = 2;

function ruleDescription(rule: NotificationRule): string | undefined {
	return (rule.description || rule.content)?.trim() || undefined;
}

/**
 * A rule's row in a multi-rule notice: the bold name and its italic
 * description, cut to its first line (with an ellipsis) while collapsed.
 * fg colors conflict with the inverse banner, so styling stays bold and italic.
 */
function ruleRow(rule: NotificationRule, collapsed: boolean): string {
	const name = theme.bold(rule.name);
	const desc = ruleDescription(rule);
	if (!desc) return name;
	const newline = desc.indexOf("\n");
	const shown = collapsed && newline !== -1 ? `${desc.slice(0, newline).trimEnd()}${theme.format.ellipsis}` : desc;
	return `${name}: ${theme.italic(shown)}`;
}

/**
 * Component that renders a TTSR (Time Traveling Stream Rules) notification.
 * Shows when a rule violation is detected and the stream is being rewound.
 * One block can carry several rules: a single event may match multiple rules,
 * and consecutive notifications merge into the previous block via
 * {@link addRules} while it is still the live transcript tail.
 */
export class TtsrNotificationComponent extends Container {
	#rules: NotificationRule[];
	readonly #notice: MessageNoticeComponent;

	constructor(rules: NotificationRule[]) {
		super();
		this.#rules = [...rules];
		this.#notice = new MessageNoticeComponent({
			presentation: context => this.#presentation(context),
			nativePresentation: () => this.#nativePresentation(),
			role: "omp.notice.ttsr",
		});
		this.addChild(this.#notice);
	}

	setToolActivityVisible(visible: boolean): void {
		this.#notice.setToolActivityVisible(visible);
	}

	/** Merge additional rules into this block (deduped by rule name). */
	addRules(rules: NotificationRule[]): void {
		let changed = false;
		for (const rule of rules) {
			if (this.#rules.some(existing => existing.name === rule.name)) continue;
			this.#rules.push(rule);
			changed = true;
		}
		if (changed) this.#notice.refresh();
	}

	setExpanded(expanded: boolean): void {
		this.#notice.setExpanded(expanded);
	}

	isExpanded(): boolean {
		return this.#notice.isExpanded();
	}

	/**
	 * An inline warning notice, "Rule applied: no-unwrap", with every rule's
	 * full description as the disclosure below it.
	 */
	#nativePresentation(): MessageNoticeNativePresentation {
		const single = this.#rules.length === 1 ? this.#rules[0] : undefined;
		const head = single
			? [span("Rule applied: ", "warning"), span(single.name, "mono strong")]
			: [
					span(`${this.#rules.length} rules applied: `, "warning"),
					span(this.#rules.map(rule => rule.name).join(", "), "mono strong"),
				];
		const body: NativeNode[] = [];
		for (const rule of this.#rules) {
			const desc = (rule.description || rule.content)?.trim();
			if (single) {
				if (desc) body.push(text([span(desc, "em")], { wrap: "word", key: rule.name }));
				continue;
			}
			body.push(
				text(desc ? [span(rule.name, "strong"), span(": "), span(desc, "em")] : [span(rule.name, "strong")], {
					wrap: "word",
					key: rule.name,
				}),
			);
		}
		return { head, body, inline: { icon: "shield-alert" } };
	}

	#presentation({ expanded, width }: MessageNoticeContext): MessageNoticePresentation {
		const single = this.#rules.length === 1 ? this.#rules[0] : undefined;
		const header = single ? `Injecting rule: ${theme.bold(single.name)}` : `Injecting ${this.#rules.length} rules:`;
		// Folding is fitted to the body width, which the notice supplies once it renders.
		if (width === 0) return { icon: theme.icon.warning, header };
		const build = (full: boolean): FoldableRows =>
			single ? this.#singleRows(single, full) : this.#multiRows(full, width);
		const rows = foldBody(build, expanded, width, theme);
		if (rows.length === 0) return { icon: theme.icon.warning, header };
		return { icon: theme.icon.warning, header, body: rows.map(row => new Text(row, 0, 0)) };
	}

	/** A lone rule's description: its first lines and the expand hint while collapsed. */
	#singleRows(rule: NotificationRule, full: boolean): FoldableRows {
		const desc = ruleDescription(rule);
		if (!desc) return { rows: [], foldRows: 0 };
		const lines = desc.split("\n");
		if (full || lines.length <= SINGLE_COLLAPSED_LINES) return { rows: [theme.italic(desc)], foldRows: 0 };
		const head = `${lines.slice(0, SINGLE_COLLAPSED_LINES).join("\n")}${theme.format.ellipsis}`;
		return { rows: [theme.italic(head), theme.italic(expandHintLabel(theme))], foldRows: 1 };
	}

	/** One row per rule, capped while collapsed, with the hint row when anything is cut. */
	#multiRows(full: boolean, width: number): FoldableRows {
		if (full) return { rows: this.#rules.map(rule => ruleRow(rule, false)), foldRows: 0 };
		const shown = cappedRowCount(this.#rules.length, MAX_COLLAPSED_RULES, width, () =>
			ruleRow(this.#rules[MAX_COLLAPSED_RULES]!, true),
		);
		const visible = this.#rules.slice(0, shown);
		const rows = visible.map(rule => ruleRow(rule, true));
		const hidden = this.#rules.length - shown;
		const elided = visible.some(rule => ruleDescription(rule)?.includes("\n"));
		if (hidden === 0 && !elided) return { rows, foldRows: 0 };
		// The inverse banner would turn a dim fg into a gray band: keep the
		// `… N more rules` row and its hint unstyled (not formatMoreRow).
		const more = hidden > 0 ? `${formatMoreItems(hidden, "rule", theme)} ` : "";
		rows.push(theme.italic(`${more}${expandHintLabel(theme)}`));
		return { rows, foldRows: 1 };
	}
}
