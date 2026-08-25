import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';

test('config: delegate key preferred over claudeDelegate', async () => {
	const dir = join(tmpdir(), `cfg-test-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		// write settings with both keys, delegate should win
		writeFileSync(join(dir, 'settings.json'), JSON.stringify({
			delegate: { defaultHarness: 'codex', defaultMode: 'plan', modelAliases: { economy: 'haiku' } },
			claudeDelegate: { defaultMode: 'review', model: 'sonnet' },
		}));
		const { loadConfig } = await import('../extensions/config.ts');
		// need to reimport fresh? loadConfig reads file each time
		const cfg = loadConfig();
		assert.equal(cfg.defaultHarness, 'codex');
		assert.equal(cfg.defaultMode, 'plan');
	} finally {
		process.env.PI_CODING_AGENT_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});

test('config: legacy claudeDelegate migrates', async () => {
	const dir = join(tmpdir(), `cfg-legacy-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		writeFileSync(join(dir, 'settings.json'), JSON.stringify({
			claudeDelegate: { defaultMode: 'review', model: 'opus', maxConcurrent: 2 },
		}));
		// dynamic import to get fresh load
		// use eval to bypass cache? Node will cache, but loadConfig re-reads file
		const { loadConfig } = await import('../extensions/config.ts');
		const cfg = loadConfig();
		assert.equal(cfg.defaultMode, 'review');
		assert.equal(cfg.harnesses['claude']?.model, 'opus');
		assert.equal(cfg.maxConcurrent, 2);
	} finally {
		process.env.PI_CODING_AGENT_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});

test('config: outputsDir partitioned', async () => {
	const { outputsDir, legacyOutputsDir } = await import('../extensions/config.ts');
	const dir = outputsDir('claude');
	assert.ok(dir.endsWith('delegate/outputs/claude') || dir.includes('claude'));
	const legacy = legacyOutputsDir();
	assert.ok(legacy.includes('claude-delegate'));
});
