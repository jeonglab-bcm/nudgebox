/**
 * SPEC 21. Go to definition: the name at a place in a commit's file, where it is defined
 * and where it is used, answered by real language servers (Pyright; TypeScript's own) on
 * the commit's code, which Nudgebox reads from GitHub as a tarball.
 * Lab users: hyunhwanj (GitHub "hwan"), kellyl ("kelly").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { start } from "../helpers/harness.ts";

const LAB = "jeonglab-bcm/labbot";
const MINE = "hyunhwan-bcm/tailjobs";
const SHA = "a".repeat(40);

const PY = {
	"pkg/__init__.py": "",
	"pkg/doi.py": 'def normalize_doi(s):\n    """Lower-case a DOI and drop its prefix."""\n    return s.lower().removeprefix("doi:")\n',
	"pkg/cli.py": "from pkg.doi import normalize_doi\n\ndef main(argv):\n    n = len(argv)\n    return [normalize_doi(a) for a in argv][:n]\n",
	"tests/test_doi.py": 'from pkg.doi import normalize_doi\n\ndef test_it():\n    assert normalize_doi("DOI:X") == "x"\n',
	"README.md": "# labbot\n",
};
const TS = {
	"src/limit.ts": '/** The most jobs shown at once. */\nexport function limitOf(kind: string): number {\n\treturn kind === "big" ? 20 : 10;\n}\n',
	"src/list.ts": 'import { limitOf } from "./limit.ts";\n\nexport const shown = (kind: string, jobs: string[]) => jobs.slice(0, limitOf(kind));\n',
	"web/page.js": 'import { limitOf } from "../src/limit.ts";\n\nconsole.log(limitOf("big"));\n',
};
// a name longer than a tar header holds: GitHub's tarballs carry such names in an extra header
const DEEP = `${"deep/".repeat(22)}far.py`;

async function setup(opts: Parameters<typeof start>[0] = {}) {
	const t = await start(opts);
	t.github.grant("hwan", LAB, MINE);
	t.github.grant("kelly", LAB);
	for (const [path, text] of Object.entries({ ...PY, ...TS, [DEEP]: "from pkg.doi import normalize_doi\nnormalize_doi('x')\n" })) t.github.blobs.set(`${LAB}@${SHA}:${path}`, text);
	t.github.blobs.set(`${MINE}@${SHA}:a.py`, "x = 1\nprint(x)\n");
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	const lookup = (as: string, body: object) => t.req("/api/code/lookup", { as, method: "POST", body: JSON.stringify(body) });
	return { t, lookup };
}
const where = (xs: { path: string; row: number }[]) => xs.map((x) => `${x.path}:${x.row + 1}`);

test("21. Python: a call leads to its definition in another file, with what it is and where it is used", async () => {
	const { t, lookup } = await setup();
	try {
		// `normalize_doi` in "    return [normalize_doi(a) for a in argv][:n]"
		const r = await lookup("hyunhwanj", { repo: LAB, ref: SHA, path: "pkg/cli.py", row: 4, col: 18 });
		assert.equal(r.status, 200, await r.clone().text());
		const a = await r.json();
		assert.deepEqual(a.definitions, [{ path: "pkg/doi.py", row: 0, col: 4, text: "def normalize_doi(s):" }]);
		assert.match(a.signature, /def normalize_doi\(s/);
		assert.match(a.doc, /Lower-case a DOI/);
		assert.deepEqual(where(a.references), [DEEP + ":1", DEEP + ":2", "pkg/cli.py:1", "pkg/cli.py:5", "tests/test_doi.py:1", "tests/test_doi.py:4"]);
		assert.equal(a.references.find((x: any) => x.path === "tests/test_doi.py" && x.row === 3).text, '    assert normalize_doi("DOI:X") == "x"');
		assert.equal(a.outside, 0);
		// a name of the language itself is defined outside the repo: said, and no place given
		const len = await (await lookup("hyunhwanj", { repo: LAB, ref: SHA, path: "pkg/cli.py", row: 3, col: 9 })).json();
		assert.deepEqual(len.definitions, []);
		assert.ok(len.outside >= 1);
		assert.match(len.signature, /len\(/);
		// the commit is fetched once, however many questions
		assert.equal(t.github.calls.filter((c) => c.op === "archive").length, 1);
	} finally {
		await t.close();
	}
});

test("21. TypeScript and JavaScript: definition and uses across files", async () => {
	const { t, lookup } = await setup();
	try {
		// `limitOf` in "... jobs.slice(0, limitOf(kind));"
		const col = TS["src/list.ts"].split("\n")[2].indexOf("limitOf") + 3;
		const r = await lookup("kellyl", { repo: LAB, ref: SHA, path: "src/list.ts", row: 2, col });
		assert.equal(r.status, 200, await r.clone().text());
		const a = await r.json();
		assert.deepEqual(a.definitions, [{ path: "src/limit.ts", row: 1, col: 16, text: "export function limitOf(kind: string): number {" }]);
		assert.match(a.signature, /limitOf\(kind: string\): number/);
		assert.match(a.doc, /The most jobs shown at once/);
		assert.deepEqual(where(a.references), ["src/list.ts:1", "src/list.ts:3", "web/page.js:1", "web/page.js:3"]);
		// asked from the JavaScript file, the same definition
		const js = await (await lookup("kellyl", { repo: LAB, ref: SHA, path: "web/page.js", row: 2, col: 14 })).json();
		assert.deepEqual(where(js.definitions), ["src/limit.ts:2"]);
	} finally {
		await t.close();
	}
});

test("21. only repos you can see, only code of a served language, only what is in the commit", async () => {
	const { t, lookup } = await setup();
	const none = await setup({ code: false });
	try {
		const ask = { repo: LAB, ref: SHA, path: "pkg/cli.py", row: 4, col: 18 };
		assert.equal((await lookup("kellyl", { ...ask, repo: MINE, path: "a.py", row: 1, col: 6 })).status, 404);
		assert.equal(t.github.calls.filter((c) => c.op === "archive").length, 0); // refused before anything is fetched
		assert.equal((await lookup("hyunhwanj", { ...ask, path: "README.md" })).status, 400);
		assert.equal((await lookup("hyunhwanj", { ...ask, row: -1 })).status, 400);
		assert.equal((await lookup("hyunhwanj", { ...ask, path: "../cli.py" })).status, 400);
		assert.equal((await lookup("hyunhwanj", { repo: LAB, path: "pkg/cli.py" })).status, 400);
		assert.equal((await lookup("hyunhwanj", { ...ask, path: "pkg/gone.py" })).status, 404);
		assert.equal((await lookup("hyunhwanj", { ...ask, ref: "b".repeat(40) })).status, 404);
		assert.equal((await none.lookup("hyunhwanj", ask)).status, 503);
		// the page is told which kinds of file it can ask about
		const kinds = (await (await t.req("/api/inbox", { as: "hyunhwanj" })).json()).code;
		assert.ok(kinds.includes("py") && kinds.includes("ts") && kinds.includes("js"));
		assert.deepEqual((await (await none.t.req("/api/inbox", { as: "hyunhwanj" })).json()).code, []);
	} finally {
		await t.close();
		await none.t.close();
	}
});

/** Every file under `dir`, as paths. */
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));

test("21. nothing but regular code files is unpacked: no links, no names that leave the folder, no settings", async () => {
	const { t, lookup } = await setup();
	try {
		t.github.links.set(`${LAB}@${SHA}:pkg/secret.py`, "/etc/passwd");
		t.github.blobs.set(`${LAB}@${SHA}:../escape.py`, "x = 1\n");
		t.github.blobs.set(`${LAB}@${SHA}:pyrightconfig.json`, '{"extraPaths": ["/"]}');
		t.github.blobs.set(`${LAB}@${SHA}:pyproject.toml`, '[tool.pyright]\nextraPaths = ["/"]\n');
		t.github.blobs.set(`${LAB}@${SHA}:node_modules/x/index.js`, "export const x = 1;\n");
		t.github.blobs.set(`${LAB}@${SHA}:data/big.py`, "x = 1\n".repeat(400_000));
		assert.equal((await lookup("hyunhwanj", { repo: LAB, ref: SHA, path: "pkg/cli.py", row: 4, col: 18 })).status, 200);
		assert.equal((await lookup("hyunhwanj", { repo: LAB, ref: SHA, path: "pkg/secret.py", row: 0, col: 0 })).status, 404);
		const unpacked = walk(t.dir).filter((p) => !/\.sqlite(-\w+)?$/.test(p) && !p.includes("/home/"));
		const names = unpacked.map((p) => p.replace(/^.*\/nudgebox-code-[^/]+\/\d+\//, "")).sort();
		assert.deepEqual(names, [DEEP, ...Object.keys({ ...PY, ...TS }).filter((p) => p !== "README.md"), "tsconfig.json"].sort());
		assert.ok(!existsSync(`${t.dir}/escape.py`));
	} finally {
		await t.close();
	}
});

test("21. a language server nobody asks for a while is stopped and its code removed; the next question starts again", async () => {
	const { t, lookup } = await setup({ codeIdleMs: 400 });
	try {
		const ask = { repo: LAB, ref: SHA, path: "pkg/cli.py", row: 4, col: 18 };
		assert.equal((await lookup("hyunhwanj", ask)).status, 200);
		assert.equal(t.code!.running(), 1);
		await new Promise((r) => setTimeout(r, 1200));
		assert.equal(t.code!.running(), 0);
		assert.deepEqual(walk(t.dir).filter((p) => p.endsWith(".py")), []);
		const again = await (await lookup("hyunhwanj", ask)).json();
		assert.deepEqual(where(again.definitions), ["pkg/doi.py:1"]);
		assert.equal(t.github.calls.filter((c) => c.op === "archive").length, 2);
	} finally {
		await t.close();
	}
	assert.equal(t.code!.running(), 0);
});
