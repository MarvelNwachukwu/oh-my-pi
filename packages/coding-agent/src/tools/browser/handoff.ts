import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isRecord, untilAborted } from "@oh-my-pi/pi-utils";
import type { Page } from "puppeteer-core";

/** Read-only conditions that end a human handoff when the first holds. */
export interface HandoffUntil {
	url?: string | RegExp;
	notUrl?: string | RegExp;
	selector?: string;
	gone?: string;
	text?: string | RegExp;
}

export type HandoffCondition = keyof HandoffUntil;

export interface HandoffOptions {
	message: string;
	until: HandoffUntil;
	/** Milliseconds to wait; defaults to the remaining browser-call budget. */
	timeout?: number;
}

export interface HandoffResult {
	met: HandoffCondition;
	url: string;
	elapsedMs: number;
}

const CONDITION_KINDS: Record<HandoffCondition, "pattern" | "selector"> = {
	url: "pattern",
	notUrl: "pattern",
	selector: "selector",
	gone: "selector",
	text: "pattern",
};
const CONDITION_ORDER = Object.keys(CONDITION_KINDS) as HandoffCondition[];
const MISSING_UNTIL = `tab.handoff() requires \`until\` with at least one of: ${CONDITION_ORDER.join(", ")}`;
const HANDOFF_POLL_MS = 500;

export function parseHandoffOptions(raw: unknown): HandoffOptions {
	if (!isRecord(raw)) throw new ToolError("tab.handoff() expects an options object: { message, until, timeout? }");
	const { message, until, timeout } = raw;
	if (typeof message !== "string" || message.trim().length === 0) {
		throw new ToolError("tab.handoff() requires a non-empty `message` telling the user what to do");
	}
	if (!isRecord(until)) throw new ToolError(MISSING_UNTIL);
	const parsed: Record<string, string | RegExp> = {};
	for (const [key, value] of Object.entries(until)) {
		if (value === undefined) continue;
		const kind = Object.hasOwn(CONDITION_KINDS, key) ? CONDITION_KINDS[key as HandoffCondition] : undefined;
		if (!kind)
			throw new ToolError(
				`tab.handoff(): unknown until.${key}; supported conditions: ${CONDITION_ORDER.join(", ")}`,
			);
		const validString = typeof value === "string" && value.length > 0;
		if (kind === "selector" && !validString) {
			throw new ToolError(`tab.handoff(): until.${key} must be a non-empty selector string`);
		}
		if (kind === "pattern" && !validString && !(value instanceof RegExp)) {
			throw new ToolError(`tab.handoff(): until.${key} must be a non-empty string or a RegExp`);
		}
		parsed[key] = value as string | RegExp;
	}
	if (Object.keys(parsed).length === 0) throw new ToolError(MISSING_UNTIL);
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
		throw new ToolError("tab.handoff(): timeout must be a positive number of milliseconds");
	}
	return { message: message.trim(), until: parsed as HandoffUntil, timeout };
}

function matches(value: string, pattern: string | RegExp): boolean {
	if (typeof pattern === "string") return value.includes(pattern);
	pattern.lastIndex = 0;
	return pattern.test(value);
}

function describeUntil(until: HandoffUntil): string {
	return CONDITION_ORDER.flatMap(key => {
		const value = until[key];
		if (value === undefined) return [];
		return [`${key} ${typeof value === "string" ? JSON.stringify(value) : String(value)}`];
	}).join(" or ");
}

/** A navigation, detached frame, or expired probe is inconclusive rather than a failed handoff. */
async function probeCount(page: Page, selector: string, signal: AbortSignal): Promise<boolean | null> {
	try {
		const handle = await untilAborted(signal, () => page.$(selector));
		if (!handle) return false;
		void handle.dispose().catch(() => undefined);
		return true;
	} catch {
		return null;
	}
}

async function probeText(page: Page, signal: AbortSignal): Promise<string | null> {
	try {
		return (await untilAborted(signal, () =>
			page.evaluate(() => {
				const pageGlobal = globalThis as unknown as { document: { body?: { innerText?: string } } };
				return pageGlobal.document.body?.innerText ?? "";
			}),
		)) as string;
	} catch {
		return null;
	}
}

/** Poll only the named completion signals; never click, type, or solve a human challenge. */
export async function waitForHandoff(
	page: Page,
	until: HandoffUntil,
	opts: { timeoutMs: number; signal: AbortSignal; normalizeSelector: (selector: string) => string; pollMs?: number },
): Promise<HandoffResult> {
	const { signal, timeoutMs } = opts;
	const pollMs = opts.pollMs ?? HANDOFF_POLL_MS;
	const selector = until.selector !== undefined ? opts.normalizeSelector(until.selector) : undefined;
	const gone = until.gone !== undefined ? opts.normalizeSelector(until.gone) : undefined;
	const started = Date.now();
	const deadline = started + timeoutMs;
	let goneSeen = false;
	const done = (met: HandoffCondition): HandoffResult => ({ met, url: page.url(), elapsedMs: Date.now() - started });

	while (true) {
		signal.throwIfAborted();
		const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
		const url = page.url();
		if (until.url !== undefined && matches(url, until.url)) return done("url");
		if (until.notUrl !== undefined && !matches(url, until.notUrl)) return done("notUrl");
		if (selector !== undefined && (await probeCount(page, selector, probeSignal)) === true) return done("selector");
		if (gone !== undefined) {
			const present = await probeCount(page, gone, probeSignal);
			if (present === true) goneSeen = true;
			else if (present === false && goneSeen) return done("gone");
		}
		if (until.text !== undefined) {
			const text = await probeText(page, probeSignal);
			if (text !== null && matches(text, until.text)) return done("text");
		}
		signal.throwIfAborted();
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await untilAborted(signal, () => Bun.sleep(Math.min(pollMs, remaining)));
	}

	const hints = [`current URL ${page.url()}`];
	if (gone !== undefined && !goneSeen) hints.push(`until.gone ${JSON.stringify(until.gone)} never appeared`);
	throw new ToolError(
		`tab.handoff() timed out after ${timeoutMs}ms waiting for the user (${describeUntil(until)}); ${hints.join("; ")}`,
	);
}
