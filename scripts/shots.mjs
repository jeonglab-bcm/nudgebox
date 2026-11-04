// Screenshots of a running demo (scripts/demo.ts): node scripts/shots.mjs <url> <out-prefix>
import { chromium } from "playwright-core";
const [url, out] = process.argv.slice(2);
const browser = await chromium.launch();
const errors = [];
for (const [name, opts] of [
	["desktop-light", { viewport: { width: 1280, height: 820 }, colorScheme: "light" }],
	["desktop-dark", { viewport: { width: 1280, height: 820 }, colorScheme: "dark" }],
	["phone-light", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light" }],
	["phone-dark", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark" }],
]) {
	const page = await browser.newPage(opts);
	page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
	await page.goto(url);
	await page.waitForSelector(".row");
	await page.evaluate(() => document.fonts.ready);
	if (opts.isMobile) await page.locator(".row").nth(1).tap();
	else { await page.keyboard.press("j"); await page.keyboard.press("x"); }
	await page.waitForTimeout(400);
	await page.screenshot({ path: `${out}-${name}.png` });
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
	if (overflow > 0) errors.push(`${name}: horizontal overflow ${overflow}px`);
	await page.close();
}
await browser.close();
console.log(errors.length ? errors.join("\n") : "ok");
