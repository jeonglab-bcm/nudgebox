/**
 * SPEC 21: go to definition and "used in", answered by real language servers: Pyright for
 * Python, TypeScript's own server for TypeScript and JavaScript. Both speak the Language
 * Server Protocol on stdin/stdout.
 *
 * A commit's code files are unpacked once from GitHub's tarball into a temp folder (a
 * "workspace"), and a server is started in it on the first question. A workspace nobody
 * asked about for a while is stopped and removed.
 *
 * Nothing from the repo is run. Only regular code files are unpacked: no links, and no
 * project settings a Python server would obey. The servers get an empty PATH, so they
 * can start no program, and an answer that points outside the workspace is not passed on.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";

/** A place in the commit's code: 0-based row and UTF-16 column, as a page's strings count; `text` is that line. */
export type CodePlace = { path: string; row: number; col: number; text: string };
export type CodeAnswer = {
	signature: string | null; // what the name is, as the language server words it
	doc: string | null; // its documentation, when it has any
	definitions: CodePlace[];
	references: CodePlace[]; // every use in the repo's own code, the definitions left out
	outside: number; // definitions outside the repo's code: the language itself, a library
};

export interface CodeIntel {
	lookup(repo: string, ref: string, path: string, row: number, col: number): Promise<CodeAnswer>;
	running(): number; // language servers alive now
	close(): Promise<void>;
}

/** A refusal with the HTTP status it becomes. */
export class CodeError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** `ready`: a line the server logs when it has found the workspace's files; before it, "used in" misses files. */
type Lang = { name: string; id: (path: string) => string; cmd: () => string[]; ready?: RegExp };
const require = createRequire(import.meta.url);
const PYTHON: Lang = {
	name: "python",
	id: () => "python",
	cmd: () => [process.execPath, "--max-old-space-size=1536", require.resolve("pyright/langserver.index.js"), "--stdio"],
	ready: /^(Found \d+ source files?|No source files found)/,
};
const TS_IDS: Record<string, string> = { ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact" };
const TYPESCRIPT: Lang = {
	name: "typescript",
	id: (path) => TS_IDS[ext(path)] ?? "typescript",
	cmd: () => [process.execPath, join(dirname(require.resolve("typescript/package.json")), "bin", "tsc"), "--lsp", "--stdio"],
};
const LANGS: Record<string, Lang> = { py: PYTHON, pyi: PYTHON, ...Object.fromEntries(Object.keys(TS_IDS).map((e) => [e, TYPESCRIPT])) };

const ext = (path: string) => (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? "").toLowerCase();

/** The file kinds go to definition works in. */
export const CODE_KINDS = Object.keys(LANGS);

// -- unpacking ---------------------------------------------------------------------------

const MAX_FILE = 2 * 1024 * 1024; // a larger "code" file is data
const MAX_FILES = 20_000;
const MAX_BYTES = 300 * 1024 * 1024; // unpacked code
const MAX_ARCHIVE = 4 * 1024 * 1024 * 1024; // read from the tarball before giving up

/** A file worth unpacking: code of a language served here, and what TypeScript reads to resolve imports. */
function wanted(path: string): boolean {
	const parts = path.split("/");
	if (parts.includes("node_modules")) return false;
	const name = parts.at(-1)!;
	return ext(name) in LANGS || name === "package.json" || /^[tj]sconfig(\..+)?\.json$/.test(name);
}

const safe = (path: string) => path !== "" && !path.startsWith("/") && !/[\\\0]/.test(path) && path.split("/").every((p) => p !== "" && p !== "." && p !== "..");

/** The `path` record of a pax extended header ("<length> key=value\n" records). */
function paxPath(body: Buffer): string | null {
	let at = 0;
	while (at < body.length) {
		const sp = body.indexOf(0x20, at);
		const len = sp < 0 ? NaN : Number(body.toString("latin1", at, sp));
		if (!Number.isInteger(len) || len <= 0) return null;
		const record = body.toString("utf8", sp + 1, at + len - 1); // without the newline
		if (record.startsWith("path=")) return record.slice(5);
		at += len;
	}
	return null;
}

/**
 * Writes the code files of a GitHub tarball (gzip; everything under one top folder) into
 * `dir`, and gives their number. Read here rather than by `tar`, so that only regular
 * files with safe names are ever written: a link in the repo is passed over.
 */
export async function unpack(archive: Readable, dir: string): Promise<number> {
	const gz = archive.pipe(createGunzip());
	archive.on("error", (e) => gz.destroy(e));
	const chunks = gz[Symbol.asyncIterator]();
	let cur: Buffer = Buffer.alloc(0);
	let read = 0;
	/** The next `n` bytes (kept only when asked); null when the archive ends first. */
	const take = async (n: number, keep: boolean): Promise<Buffer | null> => {
		const parts: Buffer[] = [];
		for (let need = n; need > 0; ) {
			if (!cur.length) {
				const next = await chunks.next();
				if (next.done) return null;
				cur = next.value as Buffer;
				if ((read += cur.length) > MAX_ARCHIVE) throw new CodeError(422, "this repository is too large for go to definition");
			}
			const piece = cur.subarray(0, need);
			cur = cur.subarray(piece.length);
			need -= piece.length;
			if (keep) parts.push(piece);
		}
		return Buffer.concat(parts);
	};
	const text = (h: Buffer, from: number, to: number) => h.toString("utf8", from, to).replace(/\0[\s\S]*$/, "");
	let files = 0, bytes = 0;
	let long: string | null = null; // the next entry's name, from a pax header
	try {
		for (;;) {
			const h = await take(512, true);
			if (!h || h.every((b) => b === 0)) break;
			if (h[124] & 0x80) throw new CodeError(422, "this repository is too large for go to definition"); // a file over 8 GB
			const size = parseInt(text(h, 124, 136).trim() || "0", 8);
			const type = String.fromCharCode(h[156] || 0x30);
			const padded = Math.ceil(size / 512) * 512;
			if (type === "x") {
				const body = await take(padded, true);
				long = body && paxPath(body.subarray(0, size));
				continue;
			}
			const prefix = text(h, 345, 500);
			const name = long ?? (prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100));
			long = null;
			const path = name.split("/").slice(1).join("/"); // without the top folder
			if (type !== "0" || !safe(path) || !wanted(path) || size > MAX_FILE) {
				if (!(await take(padded, false))) break;
				continue;
			}
			if (++files > MAX_FILES || (bytes += size) > MAX_BYTES) throw new CodeError(422, "this repository is too large for go to definition");
			const body = await take(padded, true);
			if (!body) break;
			await mkdir(dirname(join(dir, path)), { recursive: true });
			await writeFile(join(dir, path), body.subarray(0, size));
		}
	} finally {
		gz.destroy();
		archive.destroy();
	}
	return files;
}

// -- one language server -----------------------------------------------------------------

type Position = { line: number; character: number };
type Location = { uri: string; range: { start: Position } } | { targetUri: string; targetSelectionRange: { start: Position } };

class Server {
	private child: ChildProcess;
	private buf: Buffer = Buffer.alloc(0);
	private nextId = 0;
	private waiting = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void; timer: NodeJS.Timeout }>();
	private opened = new Set<string>();
	private found: () => void = () => {};
	private exited: () => void = () => {};
	private readonly gone = new Promise<void>((r) => (this.exited = r));
	/** Settles when the server has found the workspace's files (at once, when it does not say). */
	readonly ready: Promise<void>;
	private says: RegExp | undefined;
	alive = true;

	constructor(cmd: string[], cwd: string, home: string, says: RegExp | undefined, onExit: () => void) {
		this.says = says;
		this.ready = says ? new Promise((r) => (this.found = r)) : Promise.resolve();
		// an empty PATH: the server can start no other program (Pyright would look for a Python)
		this.child = spawn(cmd[0], cmd.slice(1), { cwd, env: { PATH: "", HOME: home, XDG_CACHE_HOME: join(home, "cache"), GOMEMLIMIT: "1536MiB" }, stdio: ["pipe", "pipe", "ignore"] });
		this.child.stdout!.on("data", (d: Buffer) => this.read(d));
		this.child.stdin!.on("error", () => {}); // a write to a server that is gone
		const gone = () => {
			if (!this.alive) return;
			this.alive = false;
			for (const w of this.waiting.values()) clearTimeout(w.timer), w.no(new Error("the language server stopped"));
			this.waiting.clear();
			this.found();
			this.exited();
			onExit();
		};
		this.child.on("exit", gone);
		this.child.on("error", gone);
	}

	private send(m: object) {
		const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...m }));
		this.child.stdin!.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
	}

	private read(d: Buffer) {
		this.buf = Buffer.concat([this.buf, d]);
		for (;;) {
			const head = this.buf.indexOf("\r\n\r\n");
			if (head < 0) return;
			const len = Number(/content-length: *(\d+)/i.exec(this.buf.toString("latin1", 0, head))?.[1]);
			if (!Number.isInteger(len)) return void this.stop(); // not the protocol
			if (this.buf.length < head + 4 + len) return;
			let m: any;
			try {
				m = JSON.parse(this.buf.toString("utf8", head + 4, head + 4 + len));
			} catch {
				return void this.stop();
			}
			this.buf = this.buf.subarray(head + 4 + len);
			if (m.method !== undefined && m.id !== undefined) {
				// the server asks: its settings (none: its defaults), or leave to register something
				this.send({ id: m.id, result: m.method === "workspace/configuration" ? (m.params?.items ?? []).map(() => null) : null });
			} else if (m.id !== undefined) {
				const w = this.waiting.get(m.id);
				if (!w) continue;
				this.waiting.delete(m.id);
				clearTimeout(w.timer);
				if (m.error) w.no(new Error(String(m.error.message ?? "language server error")));
				else w.ok(m.result);
			} else if (m.method === "window/logMessage" && this.says?.test(String(m.params?.message))) {
				this.found();
			}
		}
	}

	request(method: string, params: object, timeoutMs: number): Promise<any> {
		if (!this.alive) return Promise.reject(new Error("the language server stopped"));
		return new Promise((ok, no) => {
			const id = ++this.nextId;
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				no(new Error("the language server took too long"));
			}, timeoutMs);
			this.waiting.set(id, { ok, no, timer });
			this.send({ id, method, params });
		});
	}

	notify(method: string, params: object) {
		if (this.alive) this.send({ method, params });
	}

	/** A file must be open before the server answers about it. */
	open(uri: string, languageId: string, text: string) {
		if (this.opened.has(uri)) return;
		this.opened.add(uri);
		this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
	}

	/** Kills the server; settles when it is gone. */
	stop(): Promise<void> {
		if (this.alive) this.child.kill("SIGKILL");
		return this.gone;
	}
}

// -- workspaces ----------------------------------------------------------------------------

export interface CodeOptions {
	/** GitHub's tarball of a repo at a commit; null when there is no such repo or commit. */
	archive: (repo: string, ref: string) => Promise<Readable | null>;
	idleMs?: number; // a workspace nobody asked about for this long is stopped (default 10 minutes)
	max?: number; // workspaces kept at once (default 3)
	dir?: string; // where workspaces go (default: the system's temp folder)
	log?: (msg: string) => void;
}

type Workspace = { key: string; dir: string; ready: Promise<void>; servers: Map<string, Promise<Server>>; timer?: NodeJS.Timeout; used: number; busy: number };

const PLAIN_PROJECT = JSON.stringify({
	compilerOptions: { allowJs: true, checkJs: false, noEmit: true, allowImportingTsExtensions: true, module: "esnext", moduleResolution: "bundler", target: "esnext", jsx: "preserve", skipLibCheck: true },
	include: ["**/*"],
});
const START_MS = 30_000, ANSWER_MS = 20_000, FETCH_MS = 120_000;
const MAX_PLACES = 300;

export function createCodeIntel(opts: CodeOptions): CodeIntel {
	const idleMs = opts.idleMs ?? 10 * 60_000;
	const max = opts.max ?? 3;
	const spaces = new Map<string, Workspace>();
	const live = new Set<Server>();
	let base: Promise<string> | null = null;
	let uses = 0;
	let closed = false;

	const baseDir = () => (base ??= (async () => realpath(await mkdtemp(join(opts.dir ?? tmpdir(), "nudgebox-code-"))))());

	async function drop(ws: Workspace) {
		if (spaces.get(ws.key) === ws) spaces.delete(ws.key);
		clearTimeout(ws.timer);
		const stopping = [...ws.servers.values()].map((s) => s.then((srv) => srv.stop(), () => {}));
		ws.servers.clear();
		await Promise.all(stopping);
		await ws.ready.catch(() => {});
		await rm(ws.dir, { recursive: true, force: true }).catch(() => {});
	}

	/** The idle clock starts again; it does not run while a question is being answered. */
	function touch(ws: Workspace) {
		ws.used = ++uses;
		clearTimeout(ws.timer);
		if (ws.busy) return;
		ws.timer = setTimeout(() => void drop(ws), idleMs);
		ws.timer.unref();
	}
	function release(ws: Workspace) {
		ws.busy--;
		if (spaces.get(ws.key) === ws) touch(ws);
	}

	/** The commit's workspace, held: the caller releases it when its question is answered. */
	async function workspace(repo: string, ref: string): Promise<Workspace> {
		if (closed) throw new CodeError(503, "go to definition is not set up");
		const key = `${repo.toLowerCase()}@${ref}`;
		let ws = spaces.get(key);
		if (!ws) {
			const dir = join(await baseDir(), String(++uses));
			const made: Workspace = { key, dir, servers: new Map(), used: 0, busy: 0, ready: Promise.resolve() };
			made.ready = (async () => {
				await mkdir(dir, { recursive: true });
				const archive = await opts.archive(repo, ref);
				if (!archive) throw new CodeError(404, "not found");
				const timer = setTimeout(() => archive.destroy(new CodeError(422, "this repository took too long to fetch")), FETCH_MS);
				try {
					const n = await unpack(archive, dir);
					// TypeScript's server finds every use only in a project; a repo without one gets a plain one
					if (!["tsconfig.json", "jsconfig.json"].some((f) => existsSync(join(dir, f)))) await writeFile(join(dir, "tsconfig.json"), PLAIN_PROJECT);
					opts.log?.(`code: ${repo}@${ref.slice(0, 7)}: ${n} files`);
				} finally {
					clearTimeout(timer);
				}
			})();
			ws = made;
			spaces.set(key, ws);
			made.ready.catch(() => void drop(made)); // a failure is not kept
			// over the limit the least recently asked goes, one in the middle of a question last
			while (spaces.size > max) await drop([...spaces.values()].filter((w) => w !== made).sort((a, b) => Math.sign(a.busy) - Math.sign(b.busy) || a.used - b.used)[0]);
		}
		ws.busy++;
		touch(ws);
		try {
			await ws.ready;
		} catch (e) {
			release(ws);
			throw e;
		}
		return ws;
	}

	function server(ws: Workspace, lang: Lang): Promise<Server> {
		let s = ws.servers.get(lang.name);
		if (!s) {
			s = (async () => {
				const home = join(await baseDir(), "home");
				await mkdir(home, { recursive: true });
				const srv: Server = new Server(lang.cmd(), ws.dir, home, lang.ready, () => {
					live.delete(srv);
					if (ws.servers.get(lang.name) === s) ws.servers.delete(lang.name); // the next question starts a new one
				});
				live.add(srv);
				const rootUri = pathToFileURL(ws.dir).href;
				try {
					await srv.request("initialize", {
						processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: "repo" }],
						capabilities: {
							textDocument: { definition: { linkSupport: false }, references: {}, hover: { contentFormat: ["markdown", "plaintext"] } },
							workspace: { configuration: true, workspaceFolders: true },
						},
					}, START_MS);
				} catch (e) {
					void srv.stop();
					throw e;
				}
				srv.notify("initialized", {});
				await Promise.race([srv.ready, new Promise((r) => setTimeout(r, START_MS).unref())]);
				if (!srv.alive) throw new Error("the language server stopped");
				return srv;
			})();
			ws.servers.set(lang.name, s);
			const mine = s;
			s.catch(() => ws.servers.get(lang.name) === mine && ws.servers.delete(lang.name));
		}
		return s;
	}

	/** The server for `path` in its commit's workspace (held), with the file open in it. */
	async function opened(repo: string, ref: string, path: string) {
		const lang = LANGS[ext(path)];
		if (!lang) throw new CodeError(400, "no go to definition for this kind of file");
		if (!safe(path)) throw new CodeError(400, "bad path");
		const ws = await workspace(repo, ref);
		try {
			const text = await readFile(join(ws.dir, path), "utf8").catch(() => null);
			if (text === null) throw new CodeError(404, "file not found");
			const srv = await server(ws, lang);
			const uri = pathToFileURL(join(ws.dir, path)).href;
			srv.open(uri, lang.id(path), text);
			return { ws, srv, uri };
		} catch (e) {
			release(ws);
			throw e;
		}
	}

	async function answer({ ws, srv, uri }: Awaited<ReturnType<typeof opened>>, row: number, col: number): Promise<CodeAnswer> {
		const at = { textDocument: { uri }, position: { line: row, character: col } };
		const [defs, refs, hover] = await Promise.all([
			srv.request("textDocument/definition", at, ANSWER_MS),
			srv.request("textDocument/references", { ...at, context: { includeDeclaration: true } }, ANSWER_MS),
			srv.request("textDocument/hover", at, ANSWER_MS).catch(() => null),
		]);
		const lines = new Map<string, Promise<string[] | null>>();
		const linesOf = (p: string) => {
			if (!lines.has(p)) lines.set(p, readFile(join(ws.dir, p), "utf8").then((t) => t.split("\n"), () => null));
			return lines.get(p)!;
		};
		let outside = 0;
		/** Locations as places in the repo, each once, in file order; what lies outside the workspace is only counted. */
		const places = async (found: unknown, count: boolean): Promise<CodePlace[]> => {
			const out = new Map<string, CodePlace>();
			for (const l of (Array.isArray(found) ? found : found ? [found] : []) as Location[]) {
				const u = "uri" in l ? l.uri : l.targetUri;
				const start = "uri" in l ? l.range.start : l.targetSelectionRange.start;
				let file: string;
				try {
					file = fileURLToPath(u);
				} catch {
					continue;
				}
				if (!file.startsWith(ws.dir + sep)) {
					if (count) outside++;
					continue;
				}
				const p = file.slice(ws.dir.length + 1).split(sep).join("/");
				const text = (await linesOf(p))?.[start.line];
				if (text === undefined) continue;
				out.set(`${p}:${start.line}:${start.character}`, { path: p, row: start.line, col: start.character, text: text.replace(/\r$/, "").slice(0, 400) });
				if (out.size >= MAX_PLACES) break;
			}
			return [...out.values()].sort((a, b) => (a.path === b.path ? a.row - b.row || a.col - b.col : a.path < b.path ? -1 : 1));
		};
		const definitions = await places(defs, true);
		const isDef = new Set(definitions.map((d) => `${d.path}:${d.row}:${d.col}`));
		const references = (await places(refs, false)).filter((r) => !isDef.has(`${r.path}:${r.row}:${r.col}`));
		return { ...hoverText(hover), definitions, references, outside };
	}

	return {
		async lookup(repo, ref, path, row, col) {
			const held = await opened(repo, ref, path);
			try {
				return await answer(held, row, col);
			} finally {
				release(held.ws);
			}
		},

		running: () => live.size,

		async close() {
			closed = true;
			await Promise.all([...spaces.values()].map(drop));
			await Promise.all([...live].map((s) => s.stop()));
			if (base) await rm(await base, { recursive: true, force: true }).catch(() => {});
		},
	};
}

/** A hover as its signature (the first code block) and the words after it. */
function hoverText(hover: any): { signature: string | null; doc: string | null } {
	const c = hover?.contents;
	const md = (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : `\`\`\`\n${x?.value ?? ""}\n\`\`\``)).join("\n") : String(c?.value ?? "")).trim();
	if (!md) return { signature: null, doc: null };
	const block = /```[^\n]*\n([\s\S]*?)\n?```/.exec(md);
	const signature = (block ? block[1] : md).trim().slice(0, 1200) || null;
	const doc = block ? md.slice(block.index + block[0].length).replace(/^[\s-]+/, "").trim().slice(0, 1200) || null : null;
	return { signature, doc };
}
