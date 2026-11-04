/**
 * The page in a real browser (SPEC 13): a proxy that plays the Keycloak sidecar in front
 * of a harness app, and headless Chromium pages that go through it.
 */
import { createServer, request, type OutgoingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContextOptions } from "playwright-core";
import { ORIGIN } from "./harness.ts";

/** Forwards to `base` as lab user `as`: identity headers always, the public origin on POSTs. */
export async function sidecar(base: string, as: string, port = 0): Promise<{ url: string; server: Server }> {
	const server = createServer((req, res) => {
		const headers: OutgoingHttpHeaders = { ...req.headers, "x-forwarded-email": `${as}@bcm.edu`, "x-forwarded-preferred-username": as, host: new URL(base).host };
		if (req.method !== "GET") headers.origin = ORIGIN;
		const up = request(base + req.url, { method: req.method, headers }, (r) => {
			res.writeHead(r.statusCode ?? 502, r.headers);
			r.pipe(res);
		});
		req.pipe(up);
	});
	await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server };
}

export const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 820 } };
export const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

let shared: Browser | null = null;
export async function browser() {
	return (shared ??= await chromium.launch());
}
export async function closeBrowser() {
	await shared?.close();
	shared = null;
}
