/**
 * SQLite (node:sqlite, built into Node) for linked people, open PRs, push devices
 * and "already notified" marks. One file; tokens are stored sealed (crypto.ts).
 */
import { DatabaseSync } from "node:sqlite";
import type { PullRequest } from "./github.ts";
import type { PushSubscription } from "./app.ts";

export interface LinkedUser {
	labUser: string;
	login: string;
	accessSealed: string;
	refreshSealed: string;
	expiresAt: string;
}

export class Store {
	private db: DatabaseSync;

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS users (lab_user TEXT PRIMARY KEY, login TEXT NOT NULL,
				access_sealed TEXT NOT NULL, refresh_sealed TEXT NOT NULL, expires_at TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS link_states (state TEXT PRIMARY KEY, lab_user TEXT NOT NULL, created INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS prs (key TEXT PRIMARY KEY, json TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS devices (endpoint TEXT PRIMARY KEY, lab_user TEXT NOT NULL, json TEXT NOT NULL, created TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS notified (key TEXT PRIMARY KEY, at TEXT NOT NULL);
		`);
	}

	close() {
		this.db.close();
	}

	// -- people ---------------------------------------------------------------

	saveUser(u: LinkedUser) {
		this.db.prepare(`INSERT INTO users VALUES (?, ?, ?, ?, ?) ON CONFLICT(lab_user) DO UPDATE SET
			login = excluded.login, access_sealed = excluded.access_sealed,
			refresh_sealed = excluded.refresh_sealed, expires_at = excluded.expires_at`)
			.run(u.labUser, u.login, u.accessSealed, u.refreshSealed, u.expiresAt);
	}

	user(labUser: string): LinkedUser | undefined {
		const r = this.db.prepare("SELECT * FROM users WHERE lab_user = ?").get(labUser) as Record<string, string> | undefined;
		return r && { labUser: r.lab_user, login: r.login, accessSealed: r.access_sealed, refreshSealed: r.refresh_sealed, expiresAt: r.expires_at };
	}

	users(): LinkedUser[] {
		return (this.db.prepare("SELECT lab_user FROM users").all() as { lab_user: string }[]).map((r) => this.user(r.lab_user)!);
	}

	usersByLogin(login: string): LinkedUser[] {
		return this.users().filter((u) => u.login.toLowerCase() === login.toLowerCase());
	}

	deleteUser(labUser: string) {
		this.db.prepare("DELETE FROM users WHERE lab_user = ?").run(labUser);
	}

	// -- one-time link states -------------------------------------------------

	addState(state: string, labUser: string, now: number) {
		this.db.prepare("DELETE FROM link_states WHERE created < ?").run(now - 15 * 60_000);
		this.db.prepare("INSERT INTO link_states VALUES (?, ?, ?)").run(state, labUser, now);
	}

	/** Consumes the state; true only if it exists, is fresh and belongs to labUser. */
	takeState(state: string, labUser: string, now: number): boolean {
		const r = this.db.prepare("SELECT lab_user, created FROM link_states WHERE state = ?").get(state) as { lab_user: string; created: number } | undefined;
		if (!r || r.lab_user !== labUser) return false;
		this.db.prepare("DELETE FROM link_states WHERE state = ?").run(state);
		return now - r.created < 15 * 60_000;
	}

	// -- pull requests --------------------------------------------------------

	replacePrs(prs: PullRequest[]) {
		this.db.exec("BEGIN");
		try {
			this.db.exec("DELETE FROM prs");
			for (const p of prs) this.putPr(p);
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	putPr(p: PullRequest) {
		this.db.prepare("INSERT OR REPLACE INTO prs VALUES (?, ?)").run(`${p.repo}#${p.number}`, JSON.stringify(p));
	}

	deletePr(repo: string, number: number) {
		this.db.prepare("DELETE FROM prs WHERE key = ?").run(`${repo}#${number}`);
	}

	pr(repo: string, number: number): PullRequest | undefined {
		const r = this.db.prepare("SELECT json FROM prs WHERE key = ?").get(`${repo}#${number}`) as { json: string } | undefined;
		return r && JSON.parse(r.json);
	}

	prs(): PullRequest[] {
		return (this.db.prepare("SELECT json FROM prs").all() as { json: string }[]).map((r) => JSON.parse(r.json));
	}

	// -- push devices ---------------------------------------------------------

	addDevice(labUser: string, sub: PushSubscription, now: string) {
		this.db.prepare("INSERT OR REPLACE INTO devices VALUES (?, ?, ?, ?)").run(sub.endpoint, labUser, JSON.stringify(sub), now);
	}

	devices(labUser: string): (PushSubscription & { created: string })[] {
		return (this.db.prepare("SELECT json, created FROM devices WHERE lab_user = ? ORDER BY created").all(labUser) as { json: string; created: string }[])
			.map((r) => ({ ...JSON.parse(r.json), created: r.created }));
	}

	deleteDevice(endpoint: string, labUser?: string) {
		if (labUser) this.db.prepare("DELETE FROM devices WHERE endpoint = ? AND lab_user = ?").run(endpoint, labUser);
		else this.db.prepare("DELETE FROM devices WHERE endpoint = ?").run(endpoint);
	}

	// -- "already notified" marks --------------------------------------------

	/** Records key; returns false if it was already there. */
	markOnce(key: string, now: string): boolean {
		return this.db.prepare("INSERT OR IGNORE INTO notified VALUES (?, ?)").run(key, now).changes === 1;
	}
}
