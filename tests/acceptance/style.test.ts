/**
 * SPEC 12.1. One writing style for every AI text: the STE80 Humanizer rules. That each
 * instruction carries it is tested with the feature (summarize, explain, guided review).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STYLE } from "../../src/style.ts";

test("12.1 the style names the rules a reader feels: answer first, short sentences, plain words, no dashes", () => {
	for (const rule of [/ASD-STE100/, /Start with the answer/, /at most 25 words/, /active voice/, /no greeting, no praise/,
		/delve/, /leverage/, /"not X, but Y"/, /em dash, an en dash or a semicolon/, /exactly as given/, /Add no fact/]) {
		assert.match(STYLE, rule);
	}
	// it obeys itself where it can: no dash and no semicolon in its own sentences
	assert.doesNotMatch(STYLE, /[—–;]/);
	assert.ok(STYLE.length < 2400, "the style is too long to put in every prompt");
});

test("12.1 the skill's licence is in the repository", () => {
	assert.match(readFileSync(new URL("../../docs/third-party/ste80-humanizer-LICENSE", import.meta.url), "utf8"), /MIT License[\s\S]*Dodaios/);
});
