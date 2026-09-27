/**
 * Relay opens must never hijack the tab the user is looking at.
 *
 * Runs the real relay server and tab supervisor/worker against a headless
 * Chromium standing in for the user's Chrome. A fake extension bridges the
 * relay's extension protocol onto raw CDP the way `chrome.debugger` does: a
 * flat root session per attached tab, child sessions reported with their id.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import type { RelayRpcRequest, TabSnapshot } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import {
	acquireBrowser,
	type BrowserHandle,
	holdBrowser,
	type PuppeteerBrowserHandle,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { Page } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

interface CdpTargetInfo {
	targetId: string;
	type: string;
	url: string;
	title: string;
}

interface CdpMessage {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { message: string };
	sessionId?: string;
}

/** The relay's Chrome extension, re-implemented over a raw CDP browser connection. */
class ChromeBackedExtension {
	#cdp: WebSocket;
	#ext: WebSocket | undefined;
	#seq = 0;
	#pending = new Map<number, PromiseWithResolvers<Record<string, unknown>>>();
	#tabIds = new Map<string, number>();
	#tabs = new Map<number, CdpTargetInfo>();
	#rootSessions = new Map<number, string>();
	#sessionTabs = new Map<string, { tabId: number; child: boolean }>();
	#nextTabId = 1;
	#helloSent = false;

	private constructor(cdp: WebSocket) {
		this.#cdp = cdp;
		cdp.addEventListener("message", event => this.#onCdp(JSON.parse(String(event.data)) as CdpMessage));
	}

	static async start(chromeWsEndpoint: string, relayPort: number): Promise<ChromeBackedExtension> {
		const cdp = new WebSocket(chromeWsEndpoint);
		await new Promise<void>((resolve, reject) => {
			cdp.addEventListener("open", () => resolve(), { once: true });
			cdp.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
		});
		const extension = new ChromeBackedExtension(cdp);
		await extension.#send("Target.setDiscoverTargets", { discover: true });
		const { targetInfos } = (await extension.#send("Target.getTargets")) as { targetInfos: CdpTargetInfo[] };
		for (const info of targetInfos) if (info.type === "page") extension.#upsert(info);
		const ext = new WebSocket(`ws://127.0.0.1:${relayPort}/ext`);
		await new Promise<void>((resolve, reject) => {
			ext.addEventListener("open", () => resolve(), { once: true });
			ext.addEventListener("error", () => reject(new Error("Extension socket failed")), { once: true });
		});
		ext.addEventListener("message", event => void extension.#onRelay(String(event.data)));
		extension.#ext = ext;
		extension.#post({
			t: "hello",
			userAgent: "test",
			browserVersion: "Chrome/151.0.0.0",
			tabs: [...extension.#tabs.keys()].map(tabId => extension.#snapshot(tabId)),
			attachedTabIds: [],
		});
		extension.#helloSent = true;
		return extension;
	}

	close(): void {
		this.#ext?.close();
		this.#cdp.close();
	}

	#send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
		const id = ++this.#seq;
		const pending = Promise.withResolvers<Record<string, unknown>>();
		this.#pending.set(id, pending);
		this.#cdp.send(JSON.stringify({ id, method, params: params ?? {}, sessionId }));
		return pending.promise;
	}

	#post(msg: Record<string, unknown>): void {
		this.#ext?.send(JSON.stringify(msg));
	}

	#snapshot(tabId: number): TabSnapshot {
		const info = this.#tabs.get(tabId)!;
		return { tabId, url: info.url, title: info.title, active: false, windowId: 1, pinned: false, groupId: -1 };
	}

	#upsert(info: CdpTargetInfo): number {
		let tabId = this.#tabIds.get(info.targetId);
		const created = tabId === undefined;
		if (tabId === undefined) {
			tabId = this.#nextTabId++;
			this.#tabIds.set(info.targetId, tabId);
		}
		this.#tabs.set(tabId, info);
		if (this.#helloSent) this.#post({ t: created ? "tabCreated" : "tabUpdated", tab: this.#snapshot(tabId) });
		return tabId;
	}

	#onCdp(msg: CdpMessage): void {
		if (msg.id !== undefined) {
			const pending = this.#pending.get(msg.id);
			this.#pending.delete(msg.id);
			if (msg.error) pending?.reject(new Error(msg.error.message));
			else pending?.resolve(msg.result ?? {});
			return;
		}
		const params = msg.params ?? {};
		if (!msg.sessionId) {
			const info = params.targetInfo as CdpTargetInfo | undefined;
			if ((msg.method === "Target.targetCreated" || msg.method === "Target.targetInfoChanged") && info) {
				if (info.type === "page") this.#upsert(info);
			} else if (msg.method === "Target.targetDestroyed") {
				const tabId = this.#tabIds.get(String(params.targetId));
				if (tabId === undefined) return;
				this.#tabIds.delete(String(params.targetId));
				this.#tabs.delete(tabId);
				this.#rootSessions.delete(tabId);
				this.#post({ t: "tabRemoved", tabId });
			}
			return;
		}
		const ref = this.#sessionTabs.get(msg.sessionId);
		if (!ref || !msg.method) return;
		if (msg.method === "Target.attachedToTarget" && typeof params.sessionId === "string") {
			this.#sessionTabs.set(params.sessionId, { tabId: ref.tabId, child: true });
		}
		this.#post({
			t: "cdpEvent",
			tabId: ref.tabId,
			sessionId: ref.child ? msg.sessionId : undefined,
			method: msg.method,
			params,
		});
	}

	async #onRelay(raw: string): Promise<void> {
		const msg = JSON.parse(raw) as { t: string; id: number } & RelayRpcRequest;
		if (msg.t !== "rpc") return;
		try {
			this.#post({ t: "rpcResult", id: msg.id, ok: true, result: await this.#rpc(msg) });
		} catch (error) {
			this.#post({ t: "rpcResult", id: msg.id, ok: false, error: (error as Error).message });
		}
	}

	#targetId(tabId: number): string {
		const info = this.#tabs.get(tabId);
		if (!info) throw new Error(`No tab with id ${tabId}`);
		return info.targetId;
	}

	async #rpc(msg: RelayRpcRequest): Promise<unknown> {
		switch (msg.op) {
			case "attach": {
				const { sessionId } = await this.#send("Target.attachToTarget", {
					targetId: this.#targetId(msg.tabId),
					flatten: true,
				});
				this.#rootSessions.set(msg.tabId, String(sessionId));
				this.#sessionTabs.set(String(sessionId), { tabId: msg.tabId, child: false });
				return {};
			}
			case "detach": {
				const root = this.#rootSessions.get(msg.tabId);
				this.#rootSessions.delete(msg.tabId);
				if (root) await this.#send("Target.detachFromTarget", { sessionId: root });
				this.#post({ t: "detached", tabId: msg.tabId, reason: "canceled_by_user", relayInitiated: true });
				return {};
			}
			case "send": {
				const root = this.#rootSessions.get(msg.tabId);
				if (!root) throw new Error("Debugger is not attached to the tab");
				return await this.#send(msg.method, msg.params, msg.sessionId ?? root);
			}
			case "createTab": {
				const { targetId } = await this.#send("Target.createTarget", { url: msg.url });
				const tabId = this.#upsert({ targetId: String(targetId), type: "page", url: msg.url, title: "" });
				return { tab: this.#snapshot(tabId) };
			}
			case "removeTab":
				await this.#send("Target.closeTarget", { targetId: this.#targetId(msg.tabId) });
				return {};
			case "activateTab":
				await this.#send("Target.activateTarget", { targetId: this.#targetId(msg.tabId) });
				return {};
			case "group":
				return { grouped: {} };
			case "ungroup":
				return {};
		}
	}
}

function page(title: string, body = ""): string {
	return `data:text/html,${encodeURIComponent(`<title>${title}</title>${body}`)}`;
}

const USER_URL = page("Job application", '<input id="name">');
const DEST_A = page("Destination A");
const DEST_B = page("Destination B");

describe.skipIf(!CHROMIUM_AVAILABLE)("relay open without app.target", () => {
	let chrome: PuppeteerBrowserHandle;
	let relay: RelayServer;
	let extension: ChromeBackedExtension;
	let relayBrowser: BrowserHandle;
	let userPage: Page;
	const opened: string[] = [];

	async function open(name: string, opts: { url?: string; adopt?: "visible" }) {
		opened.push(name);
		return (await acquireTab(name, relayBrowser, { ...opts, timeoutMs: 30_000 })).tab;
	}

	/** URLs of every page in the "user's" Chrome, including tabs the relay created. */
	async function chromeUrls(): Promise<string[]> {
		return (await chrome.browser.pages()).map(p => p.url()).sort();
	}

	/** Put the user's half-filled form back on their tab, so one hijack cannot mask the next case. */
	async function showUserForm(): Promise<void> {
		await userPage.goto(USER_URL);
		await userPage.type("#name", "Ada");
	}

	beforeAll(async () => {
		const launched = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in launched)) throw new Error("Expected a Puppeteer browser");
		chrome = launched;
		holdBrowser(chrome);
		// The user's only tab: a half-filled form they are looking at.
		userPage = await chrome.browser.newPage();
		await showUserForm();
		for (const other of await chrome.browser.pages()) if (other !== userPage) await other.close();

		const port = await findFreeCdpPort();
		relay = startRelayServer({ port, group: false });
		extension = await ChromeBackedExtension.start(chrome.browser.wsEndpoint(), port);
		relayBrowser = await acquireBrowser(
			{ kind: "relay", cdpUrl: `http://127.0.0.1:${port}` },
			{ cwd: process.cwd() },
		);
		holdBrowser(relayBrowser);
	}, 45_000);

	afterEach(async () => {
		for (const name of opened.splice(0)) await releaseTab(name, { kill: false });
		// Relay-created tabs survive release by design; clear them between cases.
		for (const other of await chrome.browser.pages()) if (other !== userPage) await other.close();
		if (userPage.url() !== USER_URL) await showUserForm();
	});

	afterAll(async () => {
		if (relayBrowser) await releaseBrowser(relayBrowser, { kill: false });
		extension?.close();
		relay?.stop();
		if (chrome) await releaseBrowser(chrome, { kill: true });
	});

	it("opens a url in a new tab and leaves the visible tab untouched", async () => {
		const tab = await open("relay-new", { url: DEST_A });

		expect(tab.info.url).toBe(DEST_A);
		expect(userPage.url()).toBe(USER_URL);
		expect(await userPage.$eval("#name", el => (el as unknown as { value: string }).value)).toBe("Ada");
		expect(await chromeUrls()).toEqual([USER_URL, DEST_A].sort());
	}, 45_000);

	it("adopts the visible tab when neither url nor target is given", async () => {
		const tab = await open("relay-adopt", {});

		expect(tab.info.url).toBe(USER_URL);
		expect(await chromeUrls()).toEqual([USER_URL]);
	}, 45_000);

	it("gives two named opens two distinct tabs", async () => {
		const first = await open("relay-a", { url: DEST_A });
		const second = await open("relay-b", { url: DEST_B });

		expect(second.targetId).not.toBe(first.targetId);
		expect([first.info.url, second.info.url]).toEqual([DEST_A, DEST_B]);
		expect(userPage.url()).toBe(USER_URL);
		expect(await chromeUrls()).toEqual([USER_URL, DEST_A, DEST_B].sort());
	}, 45_000);

	it("adopts and navigates the visible tab for a url when adopt: 'visible' is set", async () => {
		const tab = await open("relay-adopt-url", { url: DEST_A, adopt: "visible" });

		expect(tab.info.url).toBe(DEST_A);
		expect(await chromeUrls()).toEqual([DEST_A]);
	}, 45_000);
});
