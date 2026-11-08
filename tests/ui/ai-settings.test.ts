/**
 * SPEC 20. The AI section of Settings, in a real browser: admin only; the address field
 * only for OpenAI-compatible; models offered from the provider; Test; Save. Providers are
 * faked by the harness. Lab users: hyunhwanj (admin, GitHub "hwan"), kellyl ("kelly").
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { start } from "../helpers/harness.ts";
import { sidecar, browser, closeBrowser, DESKTOP } from "../helpers/browser.ts";

const LAB = "jeonglab-bcm/labbot";
after(closeBrowser);

async function open(as = "hyunhwanj") {
	const t = await start();
	t.github.grant("hwan", LAB);
	t.github.grant("kelly", LAB);
	t.github.addPr({ repo: LAB, number: 1, author: "kelly", title: "Review me" });
	await t.link("hyunhwanj", "hwan");
	await t.link("kellyl", "kelly");
	await t.app.sync();
	const side = await sidecar(t.base, as);
	const ctx = await (await browser()).newContext(DESKTOP);
	const page = await ctx.newPage();
	await page.goto(side.url + "#settings");
	await page.waitForSelector("#settings-page #github");
	const close = async () => {
		await ctx.close();
		side.server.close();
		await t.close();
	};
	return { t, page, close };
}

const text = async (page: Page, sel: string) => ((await page.locator(sel).first().textContent()) ?? "").replace(/\s+/g, " ");
const options = (page: Page) => page.locator("#ai-models option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
async function until(f: () => Promise<boolean>, ms = 3000) {
	const end = Date.now() + ms;
	while (!(await f())) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 50));
	}
}

test("20.12 only an admin sees the AI section", async () => {
	const admin = await open();
	const other = await open("kellyl");
	try {
		await admin.page.waitForSelector("#ai");
		assert.match(await text(admin.page, "#ai"), /AI/);
		assert.equal(await other.page.locator("#ai").count(), 0);
	} finally {
		await admin.close();
		await other.close();
	}
});

test("20.19 the address field shows only for OpenAI-compatible; models come from the provider", async () => {
	const s = await open();
	try {
		await s.page.waitForSelector("#ai");
		await s.page.getByLabel("OpenAI-compatible").check();
		assert.equal(await s.page.locator("#ai-address").isVisible(), true);
		await s.page.getByLabel("OpenAI", { exact: true }).check();
		assert.equal(await s.page.locator("#ai-address").isVisible(), false);
		await s.page.getByLabel("Anthropic").check();
		assert.equal(await s.page.locator("#ai-address").isVisible(), false);
		await s.page.locator("#ai-key").fill("sk-ant-1");
		await s.page.locator("#ai-key").blur();
		await until(async () => (await options(s.page)).length === 2);
		assert.deepEqual(await options(s.page), ["fake-a", "fake-b"]);
		assert.equal(s.t.llm.listed.at(-1)!.provider, "anthropic");
	} finally {
		await s.close();
	}
});

test("20.14 Test reports the time, or the provider's error; Save applies and the key is not shown again", async () => {
	const s = await open();
	try {
		await s.page.waitForSelector("#ai");
		await s.page.getByLabel("Anthropic").check();
		await s.page.locator("#ai-key").fill("wrong");
		await s.page.locator("#ai-model").fill("claude-everyday");
		await s.page.getByRole("button", { name: "Test", exact: true }).click();
		await until(async () => /invalid x-api-key/.test(await text(s.page, "#ai-result")));
		await s.page.locator("#ai-key").fill("sk-ant-good");
		await s.page.getByRole("button", { name: "Test", exact: true }).click();
		await until(async () => /Answered in/.test(await text(s.page, "#ai-result")));
		await s.page.locator("#ai-deep-model").fill("claude-deep");
		await s.page.getByRole("button", { name: "Save", exact: true }).click();
		await until(async () => (await (await s.t.req("/api/ai", { as: "hyunhwanj" })).json()).from === "page");
		const saved = await (await s.t.req("/api/ai", { as: "hyunhwanj" })).json();
		assert.deepEqual([saved.provider, saved.model, saved.deepModel, saved.keySet], ["anthropic", "claude-everyday", "claude-deep", true]);
		await s.page.reload();
		await s.page.waitForSelector("#ai");
		assert.equal(await s.page.locator("#ai-key").inputValue(), "", "the key is never put back in the page");
		assert.match(await s.page.locator("#ai-key").getAttribute("placeholder") ?? "", /saved/i);
		assert.equal(await s.page.getByLabel("Anthropic").isChecked(), true);
		assert.equal(await s.page.locator("#ai-model").inputValue(), "claude-everyday");
	} finally {
		await s.close();
	}
});
