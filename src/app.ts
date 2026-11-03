/**
 * The app: HTTP handler (pages, API, webhook) plus the sync and stale-digest jobs.
 * Not implemented yet; the acceptance tests in tests/acceptance define it.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GitHubPort } from "./github.ts";

export interface Config {
	orgs: string[]; // accounts the GitHub App is installed on
	staleDays: number; // SPEC 7.3
	timezone: string; // for the 09:00 digest
}

export interface PushSubscription {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export interface PushPayload {
	title: string;
	body: string;
	url?: string;
}

export interface AppOptions {
	config: Config;
	origin: string; // e.g. https://gh.bioinfolder.com, for the cross-site POST check
	github: GitHubPort;
	webhookSecret: string;
	encryptionKey: Buffer; // 32 bytes, encrypts stored GitHub tokens
	dbPath: string;
	push: (sub: PushSubscription, payload: PushPayload) => Promise<void>; // throws {statusCode: 410} when gone
	now: () => Date;
}

export interface App {
	handler: (req: IncomingMessage, res: ServerResponse) => void;
	sync(): Promise<void>; // full refresh from GitHub (start-up and every 10 min)
	runStaleDigest(): Promise<void>; // the daily stale-PR push
	idle(): Promise<void>; // resolves when webhook-triggered work has finished
	close(): Promise<void>;
}

export function createApp(_opts: AppOptions): App {
	throw new Error("not implemented");
}
