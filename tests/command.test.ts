import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeCommand, resolveDefaults } from "../extensions/command.ts";
import { parseTemplate } from "../extensions/templates.ts";

const MODES = new Set(["review", "plan", "implement", "security-audit", "docs", "general"]);

const TEMPLATES = new Map([
	["review", parseTemplate("---\nname: review\ndefaultTask: Review the git diff\ndefaultScope: diff\n---\nbody")!],
	["security-audit", parseTemplate("---\nname: security-audit\ndefaultTask: Audit the repo\n---\nbody")!],
	["plan", parseTemplate("---\nname: plan\n---\nbody")!],
]);

test("bare mode name as first word", () => {
	assert.deepEqual(parseClaudeCommand("review the auth flow", MODES), {
		task: "the auth flow",
		mode: "review",
	});
});

test("bare mode alone yields empty task", () => {
	const r = parseClaudeCommand("review", MODES);
	assert.equal(r.mode, "review");
	assert.equal(r.task, "");
});

test("explicit --mode wins over first word", () => {
	assert.equal(parseClaudeCommand("--mode=plan write a plan", MODES).mode, "plan");
	assert.equal(parseClaudeCommand("--mode=plan review", MODES).mode, "plan");
});

test("non-mode first word stays in the task", () => {
	const r = parseClaudeCommand("help me fix a bug", MODES);
	assert.equal(r.mode, undefined);
	assert.equal(r.task, "help me fix a bug");
});

test("flags parse with defaults", () => {
	assert.deepEqual(parseClaudeCommand("--mode=security-audit --scope=auth/ --model=opus --budget=3 audit it", MODES), {
		task: "audit it",
		mode: "security-audit",
		model: "opus",
		scope: "auth/",
		budget: 3,
	});
});

test("--pr and --resume flags parse", () => {
	const r = parseClaudeCommand("--mode=review --pr=42 --resume=abc-123 review it", MODES);
	assert.equal(r.mode, "review");
	assert.equal(r.pr, "42");
	assert.equal(r.sessionId, "abc-123");
});

test("empty input", () => {
	assert.deepEqual(parseClaudeCommand("", MODES), { task: "" });
});

test("resolveDefaults applies template defaults for bare modes", () => {
	assert.deepEqual(resolveDefaults({ task: "", mode: "review" }, TEMPLATES), {
		task: "Review the git diff",
		scope: "diff",
	});
	assert.deepEqual(resolveDefaults({ task: "", mode: "security-audit" }, TEMPLATES), {
		task: "Audit the repo",
	});
});

test("resolveDefaults returns null when a mode needs a prompt", () => {
	assert.equal(resolveDefaults({ task: "", mode: "plan" }, TEMPLATES), null);
	assert.equal(resolveDefaults({ task: "" }, TEMPLATES), null);
});

test("resolveDefaults passes through an explicit prompt", () => {
	assert.deepEqual(resolveDefaults({ task: "review the auth flow", mode: "review" }, TEMPLATES), {
		task: "review the auth flow",
	});
});

test("explicit scope wins over the template default", () => {
	assert.deepEqual(resolveDefaults({ task: "", mode: "review", scope: "auth/" }, TEMPLATES), {
		task: "Review the git diff",
		scope: "auth/",
	});
});
