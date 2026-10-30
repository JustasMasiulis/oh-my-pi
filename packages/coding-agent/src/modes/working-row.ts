/**
 * The working row under the transcript while a turn runs: the interrupt key,
 * the shimmering working message, and a right-docked trailer (gen tok/s, the
 * band-mode session title).
 */
import { Loader, type LoaderMessageColorFn, type TUI } from "@oh-my-pi/pi-tui";
import { sanitizeStatusText } from "@oh-my-pi/pi-tui/chrome/shared";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { type ShimmerPalette, shimmerEnabled, shimmerText } from "@oh-my-pi/pi-tui/theme/shimmer";

export const DEFAULT_WORKING_MESSAGE = "Working…";

/** Job ids the async-wait working row lists before collapsing the rest to `+N`. */
const ASYNC_WAIT_LISTED_JOBS = 3;

/** Native working-message shimmer under a session accent: the hue itself is the terminal's `accent`. */
export const NATIVE_ACCENT_SHIMMER: ShimmerPalette = { low: "dim", mid: "accent", high: "accent", bold: true };

/** The session accent tinting the working row's glyph and shimmer. */
export interface WorkingMessageAccent {
	main: string;
	dim: string;
	/**
	 * Interned shimmer palette for this accent so `compile()` inside
	 * `shimmerText` sees a stable palette object between animation ticks.
	 * A fresh palette literal every frame guaranteed a cache miss on the
	 * Symbol-keyed compiled-ANSI slot and forced `resolveTierAnsi` to walk
	 * every tier open/close for the ~30fps loader redraw (issue #4377).
	 */
	palette?: ShimmerPalette;
}

export interface WorkingLoaderOptions {
	/** Display label of the interrupt key leading the row (`esc`). */
	readonly interruptLabel: string;
	/** Session accent, re-read on every paint; undefined uses the theme's shimmer. */
	readonly accent: () => WorkingMessageAccent | undefined;
	/** Right-docked suffix, re-read on every paint. */
	readonly trailer: () => string | undefined;
}

function renderWorkingMessage(message: string, accent: WorkingMessageAccent | undefined): string {
	if (!accent) return shimmerText(message, theme);
	accent.palette ??= {
		low: "dim",
		mid: { ansi: accent.main },
		high: { ansi: accent.main },
		bold: true,
	};
	return shimmerText(message, theme, accent.palette);
}

/** The working row's loader, showing {@link DEFAULT_WORKING_MESSAGE} until given another message. */
export function createWorkingLoader(ui: TUI, options: WorkingLoaderOptions): Loader {
	const shimmer = (message: string): string => renderWorkingMessage(message, options.accent());
	// Shimmer drives the 30fps redraw; when it is disabled the working
	// message is static, so leave `animated` unset and let the loader use
	// the spinner-only ~12.5fps cadence instead of repainting a frozen line.
	const messageColorFn: LoaderMessageColorFn = shimmerEnabled()
		? Object.assign(shimmer, { animated: true as const })
		: shimmer;
	const loader = new Loader(
		ui,
		spinner => {
			const accent = options.accent();
			return accent ? `${accent.dim}${spinner}\x1b[39m` : theme.fg("muted", spinner);
		},
		messageColorFn,
		DEFAULT_WORKING_MESSAGE,
		// The brand spinner lives in the status line while working; this row
		// leads with the interrupt affordance instead of a second spinner.
		// The leading space nudges the row one column right of the flush-left
		// status rows so the interrupt glyph reads as indented.
		[` ${options.interruptLabel}`],
	);
	loader.setTrailer(options.trailer);
	return loader;
}

/**
 * Right-docked suffix of the working row: the generation tok/s readout, then
 * the session title (dim, italic). Undefined when neither is shown.
 */
export function formatWorkingRowTrailer(tokenRate: number | undefined, title: string | undefined): string | undefined {
	const rate =
		tokenRate === undefined ? undefined : theme.fg("dim", `${theme.icon.throughput} ${tokenRate.toFixed(1)} tok/s`);
	const name = title ? `\x1b[2;3m${sanitizeStatusText(title)}\x1b[23;22m` : undefined;
	if (rate && name) return `${rate}  ${name}`;
	return rate ?? name;
}

/** Working-row text while the run only waits on background jobs; short enough for a narrow terminal. */
export function formatAsyncWaitLabel(jobIds: readonly string[]): string {
	if (jobIds.length === 0) return "Waiting for background work";
	if (jobIds.length === 1) return `Waiting for background job ${jobIds[0]}`;
	const listed = jobIds.slice(0, ASYNC_WAIT_LISTED_JOBS).join(", ");
	const more = jobIds.length > ASYNC_WAIT_LISTED_JOBS ? ` +${jobIds.length - ASYNC_WAIT_LISTED_JOBS}` : "";
	return `Waiting for ${jobIds.length} background jobs: ${listed}${more}`;
}
