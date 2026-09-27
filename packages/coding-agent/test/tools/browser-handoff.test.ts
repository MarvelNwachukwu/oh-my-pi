import { afterAll, describe, expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

// `/c/new` stands in for a form behind a CAPTCHA: the "user" finishes after a
// delay, which the page simulates by navigating away / removing the widget.
// These are page-side timers in Chromium; fake test timers cannot drive them.
const server = Bun.serve({
	port: 0,
	fetch(request) {
		const { pathname } = new URL(request.url);
		const body =
			pathname === "/c/new"
				? `<iframe id="captcha" srcdoc="solve me"></iframe><script>setTimeout(() => { location.href = "/c/done"; }, 800);</script>`
				: pathname === "/widget"
					? `<iframe id="captcha" srcdoc="solve me"></iframe><script>setTimeout(() => document.getElementById("captcha").remove(), 800);</script>`
					: "<p>Thanks for applying</p>";
		return new Response(`<!doctype html><title>${pathname}</title><body>${body}</body>`, {
			headers: { "content-type": "text/html" },
		});
	},
});
const baseUrl = `http://127.0.0.1:${server.port}`;

interface UiRecord {
	notices: string[];
	status: (string | undefined)[];
}

function createHost(interactive: boolean) {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: interactive,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.cmux": false,
			"ask.notify": "off",
			"tools.maxTimeout": 0,
		}),
	};
	const record: UiRecord = { notices: [], status: [] };
	const ui = {
		notify: (message: string) => record.notices.push(message),
		setStatus: (key: string, text: string | undefined) => {
			if (key === "browser-handoff") record.status.push(text);
		},
	};
	const context = interactive ? ({ hasUI: true, ui } as unknown as AgentToolContext) : undefined;
	const prelude = createBrowserPrelude(session);
	const invoke = (parameters: unknown) =>
		prelude.invoke(parameters, { session, toolCallId: `browser-handoff-${crypto.randomUUID()}`, context });
	// Real JS facade: exercises argument encoding (nested RegExp in `until`) end to end.
	// The eval bridge hands parameters to the host as cloned data; mirror that here.
	const realm = createContext({
		__omp_display__: () => undefined,
		__omp_prelude__: async (_name: string, parameters: unknown) => ({
			details: (await invoke(structuredClone(parameters))).details,
		}),
	});
	runInContext(prelude.javascript, realm);
	const js = (code: string): Promise<unknown> => runInContext(code, realm);
	return { invoke, js, record };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("Expected rejection");
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	server.stop(true);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("tab.handoff()", () => {
	test("tells the user, then resolves once the page leaves the handed-off URL", async () => {
		const { js, record } = createHost(true);
		await js(
			`(async () => { globalThis.tab = await browser.open({ name: "handoff-url", url: ${JSON.stringify(`${baseUrl}/c/new`)} }); })()`,
		);

		const result = await js(
			'tab.handoff({ message: "Solve the CAPTCHA, then submit", until: { url: /\\/c\\/done$/ }, timeout: 10000 })',
		);

		expect(result).toMatchObject({ met: "url", url: `${baseUrl}/c/done` });
		expect(record.notices).toHaveLength(1);
		expect(record.notices[0]).toContain("Solve the CAPTCHA, then submit");
		expect(record.status[0]).toContain("Solve the CAPTCHA, then submit");
		expect(record.status.at(-1)).toBeUndefined();
	}, 30_000);

	test("`gone` waits for the widget to disappear, and times out naming a widget that never appeared", async () => {
		const { invoke, record } = createHost(true);
		await invoke({ action: "open", name: "handoff-gone", url: `${baseUrl}/widget` });
		const handoff = (until: Record<string, unknown>, timeout: number) =>
			invoke({
				action: "call",
				name: "handoff-gone",
				chain: [{ method: "handoff", args: [{ message: "Finish the check", until, timeout }] }],
			});

		const done = await handoff({ gone: "#captcha" }, 10_000);
		expect(done.details).toMatchObject({ value: { met: "gone" } });

		// Already absent from the start: must not count as "the user finished".
		const message = await rejection(handoff({ gone: "#captcha" }, 1_500));
		expect(message).toContain("tab.handoff() timed out after 1500ms");
		expect(message).toContain('until.gone "#captcha" never appeared');
		expect(record.status.at(-1)).toBeUndefined();
	}, 30_000);

	test("fails fast without an interactive UI instead of waiting on nobody", async () => {
		const { invoke } = createHost(false);
		await invoke({ action: "open", name: "handoff-headless", url: `${baseUrl}/c/new` });
		const started = Date.now();
		const message = await rejection(
			invoke({
				action: "call",
				name: "handoff-headless",
				chain: [{ method: "handoff", args: [{ message: "Log in", until: { notUrl: "/c/new" } }] }],
			}),
		);
		expect(message).toContain("tab.handoff() needs an interactive omp session");
		expect(Date.now() - started).toBeLessThan(5_000);
	}, 30_000);

	test("rejects an unknown `until` key before announcing anything", async () => {
		const { invoke, record } = createHost(true);
		await invoke({ action: "open", name: "handoff-typo", url: `${baseUrl}/c/new` });
		const message = await rejection(
			invoke({
				action: "call",
				name: "handoff-typo",
				chain: [{ method: "handoff", args: [{ message: "Log in", until: { urll: "/done" } }] }],
			}),
		);
		expect(message).toContain("unknown until.urll");
		expect(record.notices).toEqual([]);
	}, 30_000);
});
