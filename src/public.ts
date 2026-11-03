/**
 * The public listener's handler (server.ts, PUBLIC_PORT): only GitHub's webhook and the
 * static web-app files, with any identity headers stripped. Everything else is 404, so
 * nothing reachable without the Keycloak sidecar can act as a lab member.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export const PUBLIC_PATHS = new Set(["/manifest.webmanifest", "/sw.js", "/app.js", "/icon.svg", "/icon-180.png", "/icon-512.png"]);

export function publicOnly(handler: (req: IncomingMessage, res: ServerResponse) => void) {
	return (req: IncomingMessage, res: ServerResponse) => {
		const path = new URL(req.url ?? "/", "http://x").pathname;
		if ((req.method === "POST" && path === "/webhook") || (req.method === "GET" && PUBLIC_PATHS.has(path))) {
			for (const h of Object.keys(req.headers)) if (h.startsWith("x-forwarded-")) delete req.headers[h];
			return handler(req, res);
		}
		res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
	};
}
