import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTemplate } from "../extensions/templates.ts";
import { mapClaudeUsage } from "../extensions/usage.ts";

test("parseTemplate extracts frontmatter and body", () => {
	const t = parseTemplate(`---
name: review
description: Review code
permissionMode: plan
model: sonnet
maxBudgetUsd: 5
---
Review the code.`);
	assert.ok(t);
	assert.equal(t!.name, "review");
	assert.equal(t!.description, "Review code");
	assert.equal(t!.permissionMode, "plan");
	assert.equal(t!.model, "sonnet");
	assert.equal(t!.maxBudgetUsd, 5);
	assert.equal(t!.prompt, "Review the code.");
});

test("parseTemplate defaults missing permission to acceptEdits", () => {
	const t = parseTemplate("---\nname: x\n---\nbody");
	assert.equal(t!.permissionMode, "acceptEdits");
});

test("parseTemplate rejects invalid permissionMode", () => {
	const t = parseTemplate("---\nname: x\npermissionMode: nope\n---\nbody");
	assert.equal(t!.permissionMode, "acceptEdits");
});

test("parseTemplate returns null without name", () => {
	assert.equal(parseTemplate("---\ndescription: no name\n---\nbody"), null);
	assert.equal(parseTemplate("no frontmatter at all"), null);
});

test("built-in templates all parse with valid modes", () => {
	const dir = new URL("../templates/", import.meta.url).pathname;
	let count = 0;
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".md")) continue;
		const t = parseTemplate(readFileSync(join(dir, f), "utf8"));
		assert.ok(t, `template ${f} should parse`);
		assert.ok(t!.name && t!.prompt, `template ${f} needs name + body`);
		count++;
	}
	assert.equal(count, 6);
});

test("mapClaudeUsage folds cache creation into input", () => {
	const u = mapClaudeUsage({
		inputTokens: 10,
		outputTokens: 20,
		cacheCreationInputTokens: 100,
		cacheReadInputTokens: 50,
		totalCostUsd: 0.123,
	});
	assert.equal(u.input, 110);
	assert.equal(u.output, 20);
	assert.equal(u.cacheRead, 50);
	assert.equal(u.cacheWrite, 0);
	assert.equal(u.totalTokens, 180);
	assert.equal(u.cost.total, 0.123);
});
