/**
 * SPEC 22. Which changed file of a PR uses which: read from the text of the files, with no
 * language server and no model. Python and JS/TS imports and Nextflow includes are resolved
 * to a file; any other use is a file naming another one (`python bin/fit.py`, `source env.sh`,
 * a link in a document). Only links between the files given are found. Code is searched
 * without its comments and docstrings: a file that is only written about is not used.
 */
import { fileKind } from "./filekind.ts";

export type GraphFile = { path: string; text: string };
export type Link = { from: string; to: string; how: "import" | "mention" }; // `from` uses `to`

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const extOf = (p: string) => /\.([^./]+)$/.exec(baseOf(p))?.[1].toLowerCase() ?? "";
const join = (dir: string, rel: string) => {
	const out = dir ? dir.split("/") : [];
	for (const part of rel.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (!out.length) return null; // above the repository
			out.pop();
		} else out.push(part);
	}
	return out.join("/");
};
/** How many leading folders two paths share. */
const shared = (a: string, b: string) => {
	const [x, y] = [dirOf(a).split("/"), dirOf(b).split("/")];
	let n = 0;
	while (n < x.length && n < y.length && x[n] === y[n]) n++;
	return n;
};

// modules of Python itself: `import json` is not a changed tools/json.py somewhere else
const PY_STD = new Set(("abc argparse array ast asyncio base64 bisect builtins calendar cmath collections concurrent configparser contextlib copy csv ctypes dataclasses " +
	"datetime decimal difflib dis email enum errno fnmatch fractions functools gc getpass glob gzip hashlib heapq hmac html http importlib inspect io ipaddress itertools json " +
	"keyword linecache locale logging lzma math mimetypes multiprocessing numbers operator os pathlib pickle platform pprint profile queue random re sched secrets select " +
	"shelve shlex shutil signal site socket sqlite3 ssl stat statistics string struct subprocess sys tarfile tempfile test textwrap threading time timeit token tokenize " +
	"trace traceback types typing unittest urllib uuid warnings weakref xml zipfile zlib zoneinfo").split(" "));

const JS = new Set("ts tsx mts cts js jsx mjs cjs vue svelte".split(" "));
const JS_EXT = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "d.ts", "vue", "svelte", "json", "css"];

/** The code of a notebook's cells, or "" when it is not one. */
function notebookCode(text: string): string {
	try {
		const cells: { cell_type?: string; source?: string | string[] }[] = JSON.parse(text).cells ?? [];
		return cells.filter((c) => c.cell_type === "code").map((c) => (Array.isArray(c.source) ? c.source.join("") : String(c.source ?? ""))).join("\n");
	} catch {
		return "";
	}
}

// -- what runs: code without its comments -------------------------------------------
type Marks = { hash?: "any" | "word"; slash?: boolean; triple?: boolean; docstrings?: boolean; backtick?: boolean };
const PY: Marks = { hash: "any", triple: true, docstrings: true };
const HASH_ANY = new Set("r jl rb pl".split(" "));
const HASH_WORD = new Set("sh bash zsh fish sbatch slurm pbs mk wdl".split(" "));
const SLASH = new Set([...JS, ..."c h cc cpp cxx hpp java go rs kt swift scala groovy css scss less".split(" ")]);

function marksOf(path: string): Marks | null {
	const [ext, name] = [extOf(path), baseOf(path)];
	if (ext === "py" || ext === "pyi" || ext === "ipynb" || ext === "smk" || name === "Snakefile") return PY;
	if (ext === "nf") return { slash: true, triple: true };
	if (SLASH.has(ext)) return { slash: true, backtick: JS.has(ext) };
	if (HASH_ANY.has(ext)) return { hash: "any" };
	if (HASH_WORD.has(ext) || /^(Makefile|GNUmakefile|Dockerfile)/.test(name)) return { hash: "word" };
	return null;
}

/**
 * The text with its comments blanked (and, in Python, its docstrings), line for line. A
 * string keeps its text: `run("fit.py")` is a use. Quotes are followed only as far as it
 * takes to tell `#` in a string from a comment.
 */
function live(path: string, text: string): string {
	if (fileKind(path) !== "code") return text;
	const blankOut = (x: string) => x.replace(/[^\n]/g, " ");
	if (/^html?$/.test(extOf(path))) return text.replace(/<!--[\s\S]*?-->/g, blankOut);
	const o = marksOf(path);
	if (!o) return text;
	const n = text.length;
	const out: string[] = [];
	let kept = 0; // text[kept..i) is not yet written
	const wipe = (a: number, b: number) => {
		out.push(text.slice(kept, a), blankOut(text.slice(a, b)));
		kept = b;
	};
	const eol = (i: number) => {
		const e = text.indexOf("\n", i);
		return e < 0 ? n : e;
	};
	for (let i = 0; i < n; ) {
		const c = text[i];
		if (c === "#" && o.hash && (o.hash === "any" || i === 0 || /\s/.test(text[i - 1]))) {
			const e = eol(i);
			wipe(i, e);
			i = e;
		} else if (c === "/" && o.slash && text[i + 1] === "/" && text[i - 1] !== ":") {
			const e = eol(i);
			wipe(i, e);
			i = e;
		} else if (c === "/" && o.slash && text[i + 1] === "*") {
			const e = text.indexOf("*/", i + 2);
			const end = e < 0 ? n : e + 2;
			wipe(i, end);
			i = end;
		} else if (c === '"' || c === "'" || (c === "`" && o.backtick)) {
			if (o.triple && text.startsWith(c.repeat(3), i)) {
				const e = text.indexOf(c.repeat(3), i + 3);
				const end = e < 0 ? n : e + 3;
				// a string that is a statement of its own says something, it does nothing
				if (o.docstrings && /^[ \t]*[rRuUbBfF]{0,2}$/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i))) wipe(i, end);
				i = end;
			} else {
				let k = i + 1;
				while (k < n && text[k] !== c && (c === "`" || text[k] !== "\n")) k += text[k] === "\\" ? 2 : 1;
				i = Math.min(k + 1, n);
			}
		} else i++;
	}
	out.push(text.slice(kept));
	return out.join("");
}

// files that run others: when two files name each other, this one is the user
const RUNNER = new Set("nf smk sh bash zsh fish sbatch slurm pbs mk wdl".split(" "));
const runs = (p: string) => RUNNER.has(extOf(p)) || /^(Snakefile|Makefile|GNUmakefile)$/.test(baseOf(p));

export function links(files: GraphFile[]): Link[] {
	const paths = files.map((f) => f.path);
	const known = new Set(paths);
	const order = new Map(paths.map((p, i) => [p, i]));
	const found = new Map<string, Link>();
	const add = (from: string, to: string | null | undefined, how: Link["how"]) => {
		if (!to || to === from || !known.has(to)) return;
		const key = `${from}\n${to}`;
		if (!found.has(key) || how === "import") found.set(key, { from, to, how });
	};
	/** The changed file that ends in `tail`, the nearest to `from` when there are several. */
	const bySuffix = (from: string, tail: string) => {
		const hits = paths.filter((p) => p === tail || p.endsWith(`/${tail}`));
		return hits.sort((a, b) => shared(b, from) - shared(a, from))[0] ?? null;
	};

	// -- Python ---------------------------------------------------------------------
	const pyModule = (from: string, dots: number, mod: string[]): string | null => {
		if (!mod.length && !dots) return null;
		const tails = mod.length ? [`${mod.join("/")}.py`, `${mod.join("/")}/__init__.py`] : ["__init__.py"];
		if (dots) {
			const base = join(dirOf(from), "../".repeat(dots - 1));
			if (base === null) return null;
			return tails.map((t) => join(base, t)).find((p) => p !== null && known.has(p)) ?? null;
		}
		// as a script next to the file, then with each folder above it as the root of the packages
		for (let root: string | null = dirOf(from); ; root = dirOf(root)) {
			const hit = tails.map((t) => (root ? `${root}/${t}` : t)).find((p) => known.has(p));
			if (hit) return hit;
			if (!root) break;
		}
		if (PY_STD.has(mod[0])) return null;
		return tails.map((t) => bySuffix(from, t)).find(Boolean) ?? null;
	};
	const python = (from: string, text: string) => {
		for (const m of text.matchAll(/^[ \t]*import[ \t]+([^\n#;]+)/gm)) {
			for (const part of m[1].split(",")) {
				const name = /^\s*([\w.]+)/.exec(part)?.[1];
				if (name) add(from, pyModule(from, 0, name.split(".").filter(Boolean)), "import");
			}
		}
		for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\(([^)]*)\)|[^\n#;]+)/gm)) {
			const [dots, mod] = [m[1].length, m[2].split(".").filter(Boolean)];
			const names = (m[4] ?? m[3]).replace(/#[^\n]*/g, "").split(",").map((x) => /^\s*([\w*]+)/.exec(x)?.[1]).filter((x): x is string => Boolean(x));
			let whole = names.length === 0;
			for (const name of names) {
				const sub = name === "*" ? null : pyModule(from, dots, [...mod, name]); // `from pkg import module`
				if (sub) add(from, sub, "import");
				else whole = true;
			}
			if (whole) add(from, pyModule(from, dots, mod), "import");
		}
	};

	// -- JS and TS ------------------------------------------------------------------
	const jsFile = (from: string, spec: string): string | null => {
		const alias = /^[@~]\//.test(spec);
		if (!alias && !spec.startsWith(".")) return null; // a package
		const p = alias ? spec.slice(2) : join(dirOf(from), spec);
		if (p === null) return null;
		const bare = p.replace(/\.(js|jsx|mjs|cjs)$/, ""); // "./x.js" is written for x.ts
		const tries = [p, ...JS_EXT.map((e) => `${p}.${e}`), ...JS_EXT.map((e) => `${bare}.${e}`), ...JS_EXT.map((e) => `${p}/index.${e}`)];
		return alias ? tries.map((t) => bySuffix(from, t)).find(Boolean) ?? null : tries.find((t) => known.has(t)) ?? null;
	};
	const js = (from: string, text: string) => {
		const specs = [/\bfrom\s*["']([^"'\n]+)["']/g, /\bimport\s*["']([^"'\n]+)["']/g, /\b(?:import|require)\s*\(\s*["']([^"'\n]+)["']\s*\)/g];
		for (const re of specs) for (const m of text.matchAll(re)) add(from, jsFile(from, m[1]), "import");
	};

	// -- Nextflow -------------------------------------------------------------------
	const nextflow = (from: string, text: string) => {
		for (const m of text.matchAll(/\binclude\s*\{[^}]*\}\s*from\s*["']([^"'\n]+)["']/g)) {
			const p = m[1].startsWith(".") ? join(dirOf(from), m[1]) : m[1];
			if (p !== null) add(from, [p, `${p}.nf`].find((t) => known.has(t)), "import");
		}
	};

	// -- any file: it names another changed file ------------------------------------
	const byName = new Map<string, string[]>();
	for (const p of paths) {
		const name = baseOf(p);
		if (name.length >= 3 && name.includes(".") && name !== "__init__.py") byName.set(name, [...(byName.get(name) ?? []), p]);
	}
	const inName = /[A-Za-z0-9_-]/;
	const mentions = (from: string, text: string) => {
		for (const [name, owners] of byName) {
			for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + name.length)) {
				const [before, after, then] = [text[at - 1] ?? "", text[at + name.length] ?? "", text[at + name.length + 1] ?? ""];
				if (inName.test(before) || before === "." || inName.test(after) || (after === "." && inName.test(then))) continue; // inside a longer name
				// how many folders of each file's path are written before the name
				const depth = (p: string) => {
					const dirs = dirOf(p) ? dirOf(p).split("/") : [];
					let n = 0;
					while (n < dirs.length && text.slice(0, at).endsWith(`${dirs.slice(dirs.length - n - 1).join("/")}/`)) n++;
					return n;
				};
				const most = Math.max(...owners.map(depth));
				let best = owners.filter((p) => depth(p) === most);
				if (best.length > 1 && best.includes(from)) continue; // its own name
				if (best.length > 1) best = best.filter((p) => dirOf(p) === dirOf(from));
				// code that names a document does not use it (`see README.md`, `path 'report.md'`)
				if (best.length === 1 && (fileKind(best[0]) !== "doc" || fileKind(from) === "doc")) add(from, best[0], "mention");
			}
		}
	};

	for (const f of files) {
		const ext = extOf(f.path);
		const text = live(f.path, ext === "ipynb" ? notebookCode(f.text) : f.text);
		if (!text.trim()) continue;
		if (ext === "py" || ext === "pyi" || ext === "ipynb" || ext === "smk" || baseOf(f.path) === "Snakefile") python(f.path, text);
		if (JS.has(ext)) js(f.path, text);
		if (ext === "nf") nextflow(f.path, text);
		mentions(f.path, text);
	}
	// two files that name each other are one use, not a circle: the import, or the file that runs the other
	for (const l of [...found.values()]) {
		const back = found.get(`${l.to}\n${l.from}`);
		if (!back || l.how !== "mention") continue;
		if (back.how === "import" || (runs(back.from) && !runs(l.from))) found.delete(`${l.from}\n${l.to}`);
	}
	return [...found.values()].sort((a, b) => order.get(a.from)! - order.get(b.from)! || order.get(a.to)! - order.get(b.to)!);
}
