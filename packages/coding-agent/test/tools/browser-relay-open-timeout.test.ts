/**
 * A relay `browser.open` adopts an existing tab and navigates it. When that
 * navigation outlives the open's timeout, the caller gets a timeout error but
 * the page keeps loading in the user's browser. The tab must then end up
 * registered under the requested name, and reopening that name must reuse it
 * instead of reloading it or opening a duplicate.
 *
 * A real headless Chromium stands in for the relay: the relay impersonates
 * Chrome's CDP discovery endpoint, so `app.relay` against Chromium's own
 * endpoint drives the exact relay path (kind resolution, extension probe,
 * attach-mode tab worker). The page's `load` event is held by an image request
 * the test releases on demand, which is how a slow real-world page outlives
 * the timeout.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { acquireBrowser, type BrowserHandle, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { getTabsMapForTest, releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { Page } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

// 1x1 transparent GIF: the held subresource that keeps `load` from firing.
const PIXEL = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), c => c.charCodeAt(0));

type Invoke = (parameters: unknown) => Promise<AgentToolResult<unknown>>;

/** `details.value` of a browser host result (`tabs` listing, `run` return value). */
function detailsValue(result: AgentToolResult<unknown>): unknown {
	const { details } = result;
	return details !== null && typeof details === "object" && "value" in details ? details.value : undefined;
}

/**
 * Message of an open expected to fail. Settled through `.catch` rather than
 * `expect(...).rejects`: under Bun 1.4 the latter closed the stand-in's own,
 * unrelated CDP websocket the moment the rejection landed.
 */
async function openFailure(invoke: Invoke, parameters: unknown): Promise<string> {
	const outcome = await invoke(parameters).then(
		() => "resolved",
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
	return outcome;
}

interface SlowSite {
	origin: string;
	/** Navigations to the form page; a reload or duplicate open would count twice. */
	formHits(): number;
	/** Let the held image (and so the page's `load` event) complete. */
	release(): void;
	stop(): Promise<void>;
}

function startSlowSite(): SlowSite {
	let hits = 0;
	const hold = Promise.withResolvers<void>();
	const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
	const server = Bun.serve({
		port: 0,
		// The held image must stay pending past Bun's default 10s idle cutoff.
		idleTimeout: 0,
		fetch: async request => {
			const { pathname } = new URL(request.url);
			if (pathname === "/start") return html("<title>start</title><main>start</main>");
			if (pathname === "/form") {
				hits++;
				return html('<title>form</title><form><input name="q"></form><img src="/pixel">');
			}
			if (pathname === "/pixel") {
				await hold.promise;
				return new Response(PIXEL, { headers: { "content-type": "image/gif" } });
			}
			return new Response("not found", { status: 404 });
		},
	});
	return {
		origin: `http://127.0.0.1:${server.port}`,
		formHits: () => hits,
		release: () => hold.resolve(),
		stop: async () => {
			hold.resolve();
			await server.stop(true);
		},
	};
}

describe.skipIf(!CHROMIUM_AVAILABLE)("relay open that outlives its timeout", () => {
	let standIn: BrowserHandle | undefined;
	let site: SlowSite | undefined;

	beforeAll(async () => {
		standIn = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
	});

	afterAll(async () => {
		if (standIn) await releaseBrowser(standIn, { kill: true });
	});

	afterEach(async () => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- releasing tabs mutates the map
		for (const name of [...getTabsMapForTest().keys()]) {
			await releaseTab(name, { kill: false }).catch(() => undefined);
		}
		await site?.stop();
		site = undefined;
	});

	/** One user tab at `/start`, the only page the relay can adopt. */
	async function prepareUserTab(): Promise<{ page: Page; invoke: Invoke }> {
		if (!standIn || !("browser" in standIn)) throw new Error("Expected a Puppeteer stand-in browser");
		site = startSlowSite();
		const page = await standIn.browser.newPage();
		await page.goto(`${site.origin}/start`);
		for (const other of await standIn.browser.pages()) {
			if (other !== page) await other.close();
		}
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({
				"browser.enabled": true,
				"browser.relay": true,
				"browser.relayUrl": `http://${new URL(standIn.browser.wsEndpoint()).host}`,
			}),
			getSessionId: () => "relay-open-timeout",
		};
		const prelude = createBrowserPrelude(session);
		const invoke: Invoke = parameters => prelude.invoke(parameters, { session, toolCallId: "relay-open-timeout" });
		return { page, invoke };
	}

	async function listTabs(invoke: Invoke): Promise<unknown> {
		return detailsValue(await invoke({ action: "tabs" }));
	}

	it("registers the tab under its name once a timed-out navigation settles", async () => {
		const { page, invoke } = await prepareUserTab();
		const formUrl = `${site!.origin}/form`;

		// The held image keeps `load` from firing for the whole test: the open
		// can only time out, and the page never reaches `load` at all.
		expect(await openFailure(invoke, { action: "open", name: "apply", url: formUrl, timeout: 5 })).toMatch(
			/timed out after 5000ms.*"apply".*same name/,
		);

		// Registration lands when the tab worker (its own thread, driving real
		// Chromium) reports ready; fake timers cannot reach that clock, so poll
		// the observable registry instead of guessing one fixed delay.
		let registered: unknown = [];
		for (let attempt = 0; attempt < 200 && Array.isArray(registered) && registered.length === 0; attempt++) {
			await Bun.sleep(50);
			registered = await listTabs(invoke);
		}
		expect(registered).toMatchObject([{ name: "apply", url: formUrl, title: "form", kind: "relay" }]);
		// The registered handle drives the page the relay adopted.
		expect(detailsValue(await invoke({ action: "run", name: "apply", code: "return tab.url();" }))).toBe(formUrl);
		expect(page.url()).toBe(formUrl);
		expect(site!.formHits()).toBe(1);
	}, 30_000);

	it("reopening the name while the timed-out open still loads reuses that tab without reloading it", async () => {
		const { page, invoke } = await prepareUserTab();
		const formUrl = `${site!.origin}/form`;

		expect(await openFailure(invoke, { action: "open", name: "apply", url: formUrl, timeout: 3 })).toMatch(
			/timed out after 3000ms/,
		);
		// Reopen at once, the way an agent retries, and only then let the page
		// finish loading: the retry must wait for the timed-out open's tab and
		// reuse it rather than start a second adoption.
		const reopen = invoke({ action: "open", name: "apply", url: formUrl, timeout: 20 });
		site!.release();
		const [first] = (await reopen).content;

		expect(first?.type === "text" ? first.text : undefined).toStartWith('Reused tab "apply"');
		expect(site!.formHits()).toBe(1);
		expect(await listTabs(invoke)).toMatchObject([{ name: "apply", url: formUrl }]);
		if (!standIn || !("browser" in standIn)) throw new Error("Expected a Puppeteer stand-in browser");
		expect(await standIn.browser.pages()).toEqual([page]);
	}, 30_000);

	it("a close issued before the timed-out open publishes discards that tab without closing the user's page", async () => {
		const { page, invoke } = await prepareUserTab();
		const formUrl = `${site!.origin}/form`;

		expect(await openFailure(invoke, { action: "open", name: "apply", url: formUrl, timeout: 3 })).toMatch(
			/timed out after 3000ms/,
		);
		await invoke({ action: "close", name: "apply" });
		// The reopen queues behind the timed-out open; once that open's page
		// loads it must be dropped (the close came first), so the reopen adopts
		// the page afresh and navigates it again instead of reusing a tab the
		// caller already closed.
		const reopen = invoke({ action: "open", name: "apply", url: formUrl, timeout: 20 });
		site!.release();
		const [first] = (await reopen).content;

		expect(first?.type === "text" ? first.text : undefined).toStartWith('Opened tab "apply"');
		expect(site!.formHits()).toBe(2);
		expect(page.isClosed()).toBe(false);
		expect(await listTabs(invoke)).toMatchObject([{ name: "apply", url: formUrl }]);
	}, 30_000);
});
