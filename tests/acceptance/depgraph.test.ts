/**
 * SPEC 22. The dependency graph of a PR's changed files: which changed file uses which,
 * read from the files themselves. Lab users: hyunhwanj (GitHub "hwan"), kellyl ("kelly").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../helpers/harness.ts";
import { links } from "../../src/depgraph.ts";

const LAB = "jeonglab-bcm/labbot";
const MINE = "hyunhwan-bcm/tailjobs";

/** "user -> used" for every link, sorted. */
const arrows = (files: Record<string, string>) =>
	links(Object.entries(files).map(([path, text]) => ({ path, text }))).map((e) => `${e.from} -> ${e.to}${e.how === "mention" ? " (mention)" : ""}`).sort();

test("22. Python: import and from-import, in the same folder, in a package, and relative", () => {
	assert.deepEqual(arrows({
		"pipeline/common.py": "import os\nimport json\n",
		"pipeline/model.py": "from common import load, save\n",
		"pipeline/fit.py": "import numpy as np\nimport common, model as m\nfrom . import plots\nfrom .stats import (\n    mean,\n    sd,\n)\n",
		"pipeline/plots.py": "",
		"pipeline/stats/__init__.py": "",
		"src/pkg/__init__.py": "",
		"src/pkg/core.py": "from pkg.util import helper\nfrom pkg import io\n",
		"src/pkg/util.py": "from ..other import thing\n",
		"src/pkg/io.py": "",
		"src/other.py": "",
		"tests/test_core.py": "from pkg.core import run\nimport pkg.util\n",
	}), [
		"pipeline/fit.py -> pipeline/common.py",
		"pipeline/fit.py -> pipeline/model.py",
		"pipeline/fit.py -> pipeline/plots.py",
		"pipeline/fit.py -> pipeline/stats/__init__.py",
		"pipeline/model.py -> pipeline/common.py",
		"src/pkg/core.py -> src/pkg/io.py",
		"src/pkg/core.py -> src/pkg/util.py",
		"src/pkg/util.py -> src/other.py",
		"tests/test_core.py -> src/pkg/core.py",
		"tests/test_core.py -> src/pkg/util.py",
	]);
});

test("22. Python: a standard module is not a changed file of the same name elsewhere; an import in a string or comment is none", () => {
	assert.deepEqual(arrows({
		"tools/json.py": "",
		"tools/dump.py": "import json\n",
		"app/run.py": "import json\n# import helper\ns = 'import helper'\n",
		"app/helper.py": "",
	}), ["tools/dump.py -> tools/json.py"]);
});

test("22. JS and TS: relative imports, with or without the extension, index files, require and import()", () => {
	assert.deepEqual(arrows({
		"src/app.ts": "import { a } from \"./store.ts\";\nimport type { B } from './github';\nexport * from \"./util/index.js\";\nimport fs from 'node:fs';\nimport x from 'left-pad';\n",
		"src/store.ts": "const g = require('./github.js');\n",
		"src/github.ts": "",
		"src/util/index.ts": "const lazy = () => import('../lazy');\n",
		"src/lazy.tsx": "",
		"tests/app.test.ts": "import { start } from \"../src/app.ts\";\n",
	}), [
		"src/app.ts -> src/github.ts",
		"src/app.ts -> src/store.ts",
		"src/app.ts -> src/util/index.ts",
		"src/store.ts -> src/github.ts",
		"src/util/index.ts -> src/lazy.tsx",
		"tests/app.test.ts -> src/app.ts",
	]);
});

test("22. scripts, pipelines and pages: a file that names another changed file uses it", () => {
	assert.deepEqual(arrows({
		"main.nf": "include { FIT } from './modules/fit'\nprocess PLOT {\n  script:\n  \"\"\"\n  python ${projectDir}/bin/plot_all.py\n  \"\"\"\n}\n",
		"modules/fit.nf": "process FIT { script: \"fit.py --in x\" }\n",
		"bin/fit.py": "",
		"bin/plot_all.py": "import subprocess\nsubprocess.run(['Rscript', 'figures.R'])\n",
		"bin/figures.R": "source(\"theme.R\")\n",
		"bin/theme.R": "",
		"run.sbatch": "#!/bin/bash\nnextflow run main.nf -c nextflow.config\nsource ./env.sh\n",
		"env.sh": "",
		"public/index.html": "<script type=\"module\" src=\"/app.js\"></script>\n",
		"public/app.js": "",
	}), [
		"bin/figures.R -> bin/theme.R (mention)",
		"bin/plot_all.py -> bin/figures.R (mention)",
		"main.nf -> bin/plot_all.py (mention)",
		"main.nf -> modules/fit.nf",
		"modules/fit.nf -> bin/fit.py (mention)",
		"public/index.html -> public/app.js (mention)",
		"run.sbatch -> env.sh (mention)",
		"run.sbatch -> main.nf (mention)",
	]);
});

test("22. a document uses the files it names; a name inside a longer name is not one; nothing uses itself", () => {
	assert.deepEqual(arrows({
		"README.md": "Run `python pipeline/fit.py`, then see [the notes](docs/notes.md). README.md is this file. refit.py and fit.pyc are not.\n",
		"pipeline/fit.py": "# fit.py: the fit\n",
		"other/fit.py": "",
		"docs/notes.md": "",
	}), [
		"README.md -> docs/notes.md (mention)",
		"README.md -> pipeline/fit.py (mention)",
	]);
});

test("22. code that names a document does not use it", () => {
	assert.deepEqual(arrows({
		"main.nf": "// see README.md\nprocess R { output: path 'report.md' }\n",
		"README.md": "Run main.nf.\n",
		"output/report.md": "",
	}), ["README.md -> main.nf (mention)"]);
});

test("22. one link per pair of files; an import counts over a mention", () => {
	assert.deepEqual(arrows({
		"a/run.py": "import helper\nimport helper\n# see helper.py\n",
		"a/helper.py": "",
	}), ["a/run.py -> a/helper.py"]);
});

async function setup() {
	const t = await start();
	t.github.grant("hwan", LAB, MINE);
	t.github.grant("kelly", LAB);
	t.github.addPr({ repo: LAB, number: 4, author: "kelly", headSha: "h1" });
	t.github.addPr({ repo: MINE, number: 7, author: "hwan" });
	const f = (path: string, status = "modified") => ({ path, status: status as "modified", additions: 1, deletions: 0 });
	t.github.prFileSets.set(`${LAB}#4`, { base: "b1", head: "h1", files: [
		f("pipeline/fit.py"), f("pipeline/common.py", "added"), f("pipeline/old.py", "removed"), f("README.md"),
		f("params/run.json"), f("figures/fig1.png"), f("pipeline/big.py"), f("pipeline/gone.py"),
	] });
	t.github.blobs.set(`${LAB}@h1:pipeline/fit.py`, "import common\nimport old\nimport big\n");
	t.github.blobs.set(`${LAB}@h1:pipeline/common.py`, "import json\n");
	t.github.blobs.set(`${LAB}@b1:pipeline/old.py`, "import common\n");
	t.github.blobs.set(`${LAB}@h1:README.md`, "See fit.py and run.json.\n");
	t.github.blobs.set(`${LAB}@h1:params/run.json`, "{\"script\": \"fit.py\"}\n");
	t.github.blobs.set(`${LAB}@h1:figures/fig1.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
	t.github.blobs.set(`${LAB}@h1:pipeline/big.py`, "import common\n" + "x = 1\n".repeat(200_000));
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	await t.app.sync();
	return t;
}
const graph = (t: Awaited<ReturnType<typeof setup>>, as: string, repo: string, n: number) =>
	t.req(`/api/prs/graph?repo=${encodeURIComponent(repo)}&number=${n}`, { as });

test("22. the graph of a PR: its code and docs as they are at the head, and the links between them", async () => {
	const t = await setup();
	try {
		const r = await graph(t, "hyunhwanj", LAB, 4);
		assert.equal(r.status, 200);
		const g = await r.json();
		assert.equal(g.head, "h1");
		// no removed file, no settings, no picture; a file too large or not there is drawn but not read
		assert.deepEqual(g.nodes, [
			{ path: "pipeline/fit.py", kind: "code" }, { path: "pipeline/common.py", kind: "code" }, { path: "README.md", kind: "doc" },
			{ path: "pipeline/big.py", kind: "code" }, { path: "pipeline/gone.py", kind: "code" },
		]);
		assert.deepEqual(g.links, [
			{ from: "pipeline/fit.py", to: "pipeline/common.py", how: "import" },
			{ from: "pipeline/fit.py", to: "pipeline/big.py", how: "import" },
			{ from: "README.md", to: "pipeline/fit.py", how: "mention" },
		]);
		assert.equal(g.others, 3);
	} finally {
		await t.close();
	}
});

test("22. the files are read once per head commit; a push reads them again", async () => {
	const t = await setup();
	try {
		let reads = 0;
		const fileAt = t.github.fileAt.bind(t.github);
		t.github.fileAt = async (...a) => { reads++; return fileAt(...a); };
		await graph(t, "hyunhwanj", LAB, 4);
		const first = reads;
		assert.ok(first > 0);
		await graph(t, "kellyl", LAB, 4);
		assert.equal(reads, first);

		const set = t.github.prFileSets.get(`${LAB}#4`)!;
		t.github.prFileSets.set(`${LAB}#4`, { ...set, head: "h2", files: set.files.filter((f) => /fit|common/.test(f.path)) });
		t.github.blobs.set(`${LAB}@h2:pipeline/fit.py`, "x = 1\n");
		t.github.blobs.set(`${LAB}@h2:pipeline/common.py`, "import fit\n");
		const g = await (await graph(t, "hyunhwanj", LAB, 4)).json();
		assert.ok(reads > first);
		assert.deepEqual(g.links, [{ from: "pipeline/common.py", to: "pipeline/fit.py", how: "import" }]);
	} finally {
		await t.close();
	}
});

test("22. the graph only for PRs you can see", async () => {
	const t = await setup();
	try {
		assert.equal((await graph(t, "kellyl", MINE, 7)).status, 404);
		assert.equal((await graph(t, "hyunhwanj", LAB, 999)).status, 404);
	} finally {
		await t.close();
	}
});
