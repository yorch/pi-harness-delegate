import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('config: delegate key preferred over claudeDelegate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-test-'));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    // write settings with both keys, delegate should win
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        delegate: { defaultHarness: 'codex', defaultMode: 'plan', modelAliases: { economy: 'haiku' } },
        claudeDelegate: { defaultMode: 'review', model: 'sonnet' },
      }),
    );
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
  const dir = mkdtempSync(join(tmpdir(), 'cfg-legacy-'));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        claudeDelegate: { defaultMode: 'review', model: 'opus', maxConcurrent: 2 },
      }),
    );
    // dynamic import to get fresh load
    // use eval to bypass cache? Node will cache, but loadConfig re-reads file
    const { loadConfig } = await import('../extensions/config.ts');
    const cfg = loadConfig();
    assert.equal(cfg.defaultMode, 'review');
    assert.equal(cfg.harnesses.claude?.model, 'opus');
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

async function loadConfigFromSettings(settings: unknown): Promise<import('../extensions/config.ts').DelegateConfig> {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-transport-'));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
    const { loadConfig } = await import('../extensions/config.ts');
    return loadConfig();
  } finally {
    process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('config: transport parses a valid value per harness', async () => {
  const cfg = await loadConfigFromSettings({ delegate: { harnesses: { opencode: { transport: 'acp' } } } });
  assert.equal(cfg.harnesses.opencode?.transport, 'acp');
});

test('config: transport absent stays undefined', async () => {
  const cfg = await loadConfigFromSettings({ delegate: { harnesses: { opencode: { model: 'big-pickle' } } } });
  assert.equal(cfg.harnesses.opencode?.transport, undefined);
  assert.equal(cfg.harnesses.opencode?.model, 'big-pickle');
});

test('config: an invalid transport value is dropped, not passed through', async () => {
  const cfg = await loadConfigFromSettings({
    delegate: { harnesses: { claude: { transport: 'websocket', model: 'sonnet' } } },
  });
  assert.equal(cfg.harnesses.claude?.transport, undefined);
  assert.equal(cfg.harnesses.claude?.model, 'sonnet'); // other fields on the same object still pass through
});

test('config: legacy claudeDelegate migration also sanitizes transport', async () => {
  const cfg = await loadConfigFromSettings({
    claudeDelegate: { harnesses: { claude: { transport: 'not-real' } } },
  });
  assert.equal(cfg.harnesses.claude?.transport, undefined);
});

test('resolveTransport: config override wins, falling back to the harness default, falling back to stdout', async () => {
  const { resolveTransport } = await import('../extensions/config.ts');
  const { devinHarness } = await import('../extensions/harnesses/devin.ts');
  const { opencodeHarness } = await import('../extensions/harnesses/opencode.ts');
  const base = await loadConfigFromSettings({ delegate: {} });

  // no override -> harness's own default ('acp' for devin, 'stdout' for opencode)
  assert.equal(resolveTransport(base, 'devin', devinHarness), 'acp');
  assert.equal(resolveTransport(base, 'opencode', opencodeHarness), 'stdout');

  // explicit override, within the harness's supported ceiling
  const overridden = await loadConfigFromSettings({ delegate: { harnesses: { opencode: { transport: 'acp' } } } });
  assert.equal(resolveTransport(overridden, 'opencode', opencodeHarness), 'acp');
});

test('getMaxConcurrent: plain number applies to both global and every harness', async () => {
  const { getMaxConcurrent } = await import('../extensions/config.ts');
  const cfg = await loadConfigFromSettings({ delegate: { maxConcurrent: 3 } });
  assert.equal(cfg.maxConcurrent, 3);
  assert.equal(getMaxConcurrent(cfg), 3);
  assert.equal(getMaxConcurrent(cfg, 'claude'), 3);
});

test('getMaxConcurrent: object shape with global only — every harness falls back to it', async () => {
  const { getMaxConcurrent } = await import('../extensions/config.ts');
  const cfg = await loadConfigFromSettings({ delegate: { maxConcurrent: { global: 5 } } });
  assert.deepEqual(cfg.maxConcurrent, { global: 5 });
  assert.equal(getMaxConcurrent(cfg), 5);
  assert.equal(getMaxConcurrent(cfg, 'claude'), 5);
  assert.equal(getMaxConcurrent(cfg, 'codex'), 5);
});

test('getMaxConcurrent: object shape with perHarness only — unlisted harnesses fall back to the default of 1, global is also 1', async () => {
  const { getMaxConcurrent } = await import('../extensions/config.ts');
  const cfg = await loadConfigFromSettings({ delegate: { maxConcurrent: { perHarness: { claude: 2 } } } });
  assert.deepEqual(cfg.maxConcurrent, { perHarness: { claude: 2 } });
  assert.equal(getMaxConcurrent(cfg, 'claude'), 2);
  // no global set on the object shape, and no matching perHarness entry -> getMaxConcurrent's own default of 1
  assert.equal(getMaxConcurrent(cfg, 'codex'), 1);
  assert.equal(getMaxConcurrent(cfg), 1);
});

test('getMaxConcurrent: object shape with both global and perHarness — perHarness wins for its harness, global is the fallback for the rest', async () => {
  const { getMaxConcurrent } = await import('../extensions/config.ts');
  const cfg = await loadConfigFromSettings({
    delegate: { maxConcurrent: { global: 4, perHarness: { claude: 1, codex: 2 } } },
  });
  assert.equal(getMaxConcurrent(cfg), 4);
  assert.equal(getMaxConcurrent(cfg, 'claude'), 1);
  assert.equal(getMaxConcurrent(cfg, 'codex'), 2);
  assert.equal(getMaxConcurrent(cfg, 'opencode'), 4);
});

test('getMaxConcurrent: malformed values are dropped, not passed through', async () => {
  const cfg = await loadConfigFromSettings({
    delegate: {
      maxConcurrent: {
        global: 'four', // wrong type
        perHarness: { claude: -1, codex: 'two', opencode: 3 }, // negative, wrong type, valid
      },
    },
  });
  // global dropped entirely (wrong type); only the valid perHarness entry survives
  assert.deepEqual(cfg.maxConcurrent, { perHarness: { opencode: 3 } });
});

test('getMaxConcurrent: a maxConcurrent that is neither a number nor an object is ignored, default (4) stands', async () => {
  const cfg = await loadConfigFromSettings({ delegate: { maxConcurrent: 'unlimited' } });
  assert.equal(cfg.maxConcurrent, 4);
});

test('config: legacy claudeDelegate migrates the object maxConcurrent shape too', async () => {
  const cfg = await loadConfigFromSettings({
    claudeDelegate: { maxConcurrent: { global: 6, perHarness: { amp: 1 } } },
  });
  assert.deepEqual(cfg.maxConcurrent, { global: 6, perHarness: { amp: 1 } });
  const { getMaxConcurrent } = await import('../extensions/config.ts');
  assert.equal(getMaxConcurrent(cfg, 'amp'), 1);
  assert.equal(getMaxConcurrent(cfg, 'claude'), 6);
});

test('resolveTransport: rejects a transport outside supportsTransports with a clear message', async () => {
  const { resolveTransport } = await import('../extensions/config.ts');
  const { claudeHarness } = await import('../extensions/harnesses/claude.ts');
  const { ampHarness } = await import('../extensions/harnesses/amp.ts');
  const claudeCfg = await loadConfigFromSettings({ delegate: { harnesses: { claude: { transport: 'acp' } } } });
  assert.throws(() => resolveTransport(claudeCfg, 'claude', claudeHarness), /claude only supports: stdout/);

  // amp/omp's ACP mode surface is a real permission-tier regression (2 tiers vs. 3) — not a legal
  // config value yet, per docs/acp-harness-assessment.md §5.
  const ampCfg = await loadConfigFromSettings({ delegate: { harnesses: { amp: { transport: 'acp' } } } });
  assert.throws(() => resolveTransport(ampCfg, 'amp', ampHarness), /amp only supports: stdout/);
});

// --- Provenance: loadConfigWithSource / describeConfigSource / buildConfigReport ---

async function withSettingsDir<T>(
  write: ((dir: string) => void) | undefined,
  fn: (dir: string) => Promise<T> | T,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-source-'));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    write?.(dir);
    return await fn(dir);
  } finally {
    process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadConfigWithSource: absent file reports fileExists:false, usedKey:none, no error', async () => {
  const { loadConfigWithSource } = await import('../extensions/config.ts');
  await withSettingsDir(undefined, () => {
    const { config, source } = loadConfigWithSource();
    assert.equal(source.fileExists, false);
    assert.equal(source.usedKey, 'none');
    assert.equal(source.legacyKeyPresent, false);
    assert.equal(source.parseError, undefined);
    assert.equal(config.defaultHarness, 'claude'); // unchanged defaults
  });
});

test('loadConfigWithSource: valid delegate key reports usedKey:delegate and the raw value', async () => {
  const { loadConfigWithSource } = await import('../extensions/config.ts');
  await withSettingsDir(
    dir => writeFileSync(join(dir, 'settings.json'), JSON.stringify({ delegate: { defaultHarness: 'codex' } })),
    () => {
      const { config, source } = loadConfigWithSource();
      assert.equal(source.fileExists, true);
      assert.equal(source.usedKey, 'delegate');
      assert.equal(source.legacyKeyPresent, false);
      assert.equal(source.parseError, undefined);
      assert.deepEqual(source.raw, { defaultHarness: 'codex' });
      assert.equal(config.defaultHarness, 'codex');
    },
  );
});

test('loadConfigWithSource: legacy claudeDelegate only reports usedKey:claudeDelegate, legacyKeyPresent:true', async () => {
  const { loadConfigWithSource } = await import('../extensions/config.ts');
  await withSettingsDir(
    dir => writeFileSync(join(dir, 'settings.json'), JSON.stringify({ claudeDelegate: { defaultMode: 'review' } })),
    () => {
      const { source } = loadConfigWithSource();
      assert.equal(source.fileExists, true);
      assert.equal(source.usedKey, 'claudeDelegate');
      assert.equal(source.legacyKeyPresent, true);
      assert.deepEqual(source.raw, { defaultMode: 'review' });
    },
  );
});

test('loadConfigWithSource: both keys present — delegate wins usedKey but legacyKeyPresent stays true', async () => {
  const { loadConfigWithSource } = await import('../extensions/config.ts');
  await withSettingsDir(
    dir =>
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ delegate: { defaultHarness: 'codex' }, claudeDelegate: { defaultMode: 'review' } }),
      ),
    () => {
      const { config, source } = loadConfigWithSource();
      assert.equal(source.usedKey, 'delegate');
      assert.equal(source.legacyKeyPresent, true);
      assert.deepEqual(source.raw, { defaultHarness: 'codex' });
      assert.equal(config.defaultHarness, 'codex');
    },
  );
});

test('loadConfigWithSource: malformed JSON reports parseError, never throws, falls back to defaults', async () => {
  const { loadConfigWithSource } = await import('../extensions/config.ts');
  await withSettingsDir(
    dir => writeFileSync(join(dir, 'settings.json'), '{ not valid json'),
    () => {
      const { config, source } = loadConfigWithSource();
      assert.equal(source.fileExists, true);
      assert.ok(source.parseError);
      assert.equal(source.usedKey, 'none');
      assert.equal(config.defaultHarness, 'claude');
    },
  );
});

test('loadConfigWithSource: a file that parses but is not an object reports parseError', async () => {
  const { loadConfigWithSource } = await import('../extensions/config.ts');
  await withSettingsDir(
    dir => writeFileSync(join(dir, 'settings.json'), JSON.stringify(['not', 'an', 'object'])),
    () => {
      const { config, source } = loadConfigWithSource();
      assert.equal(source.fileExists, true);
      assert.ok(source.parseError);
      assert.equal(source.usedKey, 'none');
      assert.equal(config.defaultHarness, 'claude');
    },
  );
});

test('describeConfigSource: legacy-only case names the cost and how to fix it', async () => {
  const { describeConfigSource } = await import('../extensions/config.ts');
  const lines = describeConfigSource({
    file: '/x/settings.json',
    fileExists: true,
    usedKey: 'claudeDelegate',
    legacyKeyPresent: true,
  });
  const text = lines.join('\n');
  assert.match(text, /legacy "claudeDelegate"/);
  assert.match(text, /defaultHarness.*stays pinned to "claude"/);
  assert.match(text, /no\s+top-level default "model"/);
  assert.match(text, /rename "claudeDelegate" to "delegate"/);
});

test('describeConfigSource: parse error is reported distinctly from "no file"/"no key"', async () => {
  const { describeConfigSource } = await import('../extensions/config.ts');
  const parseErrLines = describeConfigSource({
    file: '/x/settings.json',
    fileExists: true,
    usedKey: 'none',
    legacyKeyPresent: false,
    parseError: 'Unexpected token',
  });
  assert.match(parseErrLines.join('\n'), /failed to parse: Unexpected token/);

  const noFileLines = describeConfigSource({
    file: '/x/settings.json',
    fileExists: false,
    usedKey: 'none',
    legacyKeyPresent: false,
  });
  assert.match(noFileLines.join('\n'), /not found/);

  const noKeyLines = describeConfigSource({
    file: '/x/settings.json',
    fileExists: true,
    usedKey: 'none',
    legacyKeyPresent: false,
  });
  assert.match(noKeyLines.join('\n'), /has no "delegate" key/);
});

test('buildConfigReport: shows both the raw file contents and the effective merged config', async () => {
  const { loadConfigWithSource, buildConfigReport } = await import('../extensions/config.ts');
  await withSettingsDir(
    dir => writeFileSync(join(dir, 'settings.json'), JSON.stringify({ delegate: { defaultHarness: 'codex' } })),
    () => {
      const result = loadConfigWithSource();
      const lines = buildConfigReport(result);
      const text = lines.join('\n');
      assert.match(text, /"defaultHarness": "codex"/); // raw, as written
      assert.match(text, /"defaultMode": "general"/); // effective, default-filled
    },
  );
});

// --- writeDelegateConfig ---

test('writeDelegateConfig: creates settings.json when none exists', async () => {
  const { writeDelegateConfig, loadConfig } = await import('../extensions/config.ts');
  await withSettingsDir(undefined, () => {
    const result = writeDelegateConfig({ defaultHarness: 'codex' });
    assert.equal(result.ok, true);
    assert.equal(loadConfig().defaultHarness, 'codex');
  });
});

test('writeDelegateConfig: replaces only the delegate key, preserving every other top-level key', async () => {
  const { writeDelegateConfig } = await import('../extensions/config.ts');
  await withSettingsDir(
    dir =>
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ theme: 'dark', packages: ['foo'], delegate: { defaultHarness: 'claude' } }),
      ),
    () => {
      const result = writeDelegateConfig({ defaultHarness: 'codex' });
      assert.equal(result.ok, true);
      const written = JSON.parse(readFileSync(result.file, 'utf8'));
      assert.equal(written.theme, 'dark');
      assert.deepEqual(written.packages, ['foo']);
      assert.equal(written.delegate.defaultHarness, 'codex');
    },
  );
});

test('writeDelegateConfig: preserves a leftover claudeDelegate key rather than removing it', async () => {
  const { writeDelegateConfig } = await import('../extensions/config.ts');
  await withSettingsDir(
    dir => writeFileSync(join(dir, 'settings.json'), JSON.stringify({ claudeDelegate: { model: 'opus' } })),
    () => {
      const result = writeDelegateConfig({ defaultHarness: 'claude' });
      assert.equal(result.ok, true);
      const written = JSON.parse(readFileSync(result.file, 'utf8'));
      assert.deepEqual(written.claudeDelegate, { model: 'opus' });
      assert.ok(written.delegate);
    },
  );
});

test('writeDelegateConfig: refuses to write over malformed JSON, file left untouched', async () => {
  const { writeDelegateConfig } = await import('../extensions/config.ts');
  await withSettingsDir(
    dir => writeFileSync(join(dir, 'settings.json'), '{ not valid json'),
    () => {
      const before = readFileSync(join(process.env.PI_CODING_AGENT_DIR as string, 'settings.json'), 'utf8');
      const result = writeDelegateConfig({ defaultHarness: 'codex' });
      assert.equal(result.ok, false);
      assert.match(result.message, /refusing to write/);
      const after = readFileSync(result.file, 'utf8');
      assert.equal(after, before);
    },
  );
});

test('writeDelegateConfig: refuses to write when the root is not a JSON object', async () => {
  const { writeDelegateConfig } = await import('../extensions/config.ts');
  await withSettingsDir(
    dir => writeFileSync(join(dir, 'settings.json'), JSON.stringify(['nope'])),
    () => {
      const result = writeDelegateConfig({ defaultHarness: 'codex' });
      assert.equal(result.ok, false);
      assert.match(result.message, /refusing to write/);
    },
  );
});

test('writeDelegateConfig: atomic write leaves no temp file behind', async () => {
  const { writeDelegateConfig } = await import('../extensions/config.ts');
  await withSettingsDir(undefined, () => {
    const result = writeDelegateConfig({ defaultHarness: 'codex' });
    assert.equal(result.ok, true);
    const leftovers = readdirSync(process.env.PI_CODING_AGENT_DIR as string).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});

// --- writeDelegateConfig hardening (adversarial review of `config init`) ---

test('writeDelegateConfig: preserves the original file mode', async () => {
  const { writeDelegateConfig } = await import('../extensions/config.ts');
  await withSettingsDir(
    dir => {
      writeFileSync(join(dir, 'settings.json'), '{"theme":"x"}', { mode: 0o600 });
      chmodSync(join(dir, 'settings.json'), 0o600);
    },
    dir => {
      assert.equal(writeDelegateConfig({}).ok, true);
      assert.equal(statSync(join(dir, 'settings.json')).mode & 0o777, 0o600);
    },
  );
});

test('writeDelegateConfig: writes through a symlinked settings.json instead of replacing the link', async () => {
  const { writeDelegateConfig } = await import('../extensions/config.ts');
  await withSettingsDir(
    dir => {
      writeFileSync(join(dir, 'real.json'), '{"theme":"x"}');
      symlinkSync(join(dir, 'real.json'), join(dir, 'settings.json'));
    },
    dir => {
      assert.equal(writeDelegateConfig({ defaultHarness: 'codex' }).ok, true);
      assert.equal(lstatSync(join(dir, 'settings.json')).isSymbolicLink(), true);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'real.json'), 'utf8')).delegate, { defaultHarness: 'codex' });
    },
  );
});

test('writeDelegateConfig: matches the existing trailing-newline convention', async () => {
  const { writeDelegateConfig } = await import('../extensions/config.ts');
  for (const nl of ['', '\n']) {
    await withSettingsDir(
      dir => writeFileSync(join(dir, 'settings.json'), `{"theme":"x"}${nl}`),
      dir => {
        writeDelegateConfig({});
        assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8').endsWith('\n'), nl === '\n');
      },
    );
  }
});

test("writeDelegateConfig: refuses while pi's settings lock is held, leaving the file untouched", async () => {
  const { writeDelegateConfig } = await import('../extensions/config.ts');
  await withSettingsDir(
    dir => {
      writeFileSync(join(dir, 'settings.json'), '{"theme":"x"}');
      mkdirSync(join(dir, 'settings.json.lock'));
    },
    dir => {
      const r = writeDelegateConfig({});
      assert.equal(r.ok, false);
      assert.match(r.message, /locked/);
      assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), '{"theme":"x"}');
      assert.equal(existsSync(join(dir, 'settings.json.lock')), true); // not ours — must not be removed
    },
  );
});

test('writeDelegateConfig: releases its lock and leaves no tmp file behind', async () => {
  const { writeDelegateConfig } = await import('../extensions/config.ts');
  await withSettingsDir(
    dir => writeFileSync(join(dir, 'settings.json'), '{}'),
    dir => {
      writeDelegateConfig({});
      assert.deepEqual(readdirSync(dir).sort(), ['settings.json']);
    },
  );
});

test('writeDelegateConfig: locks the path pi locks even when settings.json is a symlink', async () => {
  const { writeDelegateConfig } = await import('../extensions/config.ts');
  await withSettingsDir(
    dir => {
      writeFileSync(join(dir, 'real.json'), '{"theme":"x"}');
      symlinkSync(join(dir, 'real.json'), join(dir, 'settings.json'));
      mkdirSync(join(dir, 'settings.json.lock')); // pi's lock: <configured path>.lock
    },
    dir => {
      const r = writeDelegateConfig({});
      assert.equal(r.ok, false);
      assert.match(r.message, /locked/);
      assert.equal(readFileSync(join(dir, 'real.json'), 'utf8'), '{"theme":"x"}');
    },
  );
});

test('nonDefaultConfig: only the aliases that differ are kept, not the untouched default ones', async () => {
  const { nonDefaultConfig, defaultDelegateConfig } = await import('../extensions/config.ts');
  const cfg = { ...defaultDelegateConfig(), modelAliases: { ...defaultDelegateConfig().modelAliases, max: 'opus-9' } };
  assert.deepEqual(nonDefaultConfig(cfg), { modelAliases: { max: 'opus-9' } });
});

test('nonDefaultConfig: omits everything still at its default, keeps real overrides', async () => {
  const { nonDefaultConfig, defaultDelegateConfig } = await import('../extensions/config.ts');
  assert.deepEqual(nonDefaultConfig(defaultDelegateConfig()), {});
  const cfg = { ...defaultDelegateConfig(), defaultHarness: 'codex', harnesses: { codex: { model: 'm' } } };
  assert.deepEqual(nonDefaultConfig(cfg), { defaultHarness: 'codex', harnesses: { codex: { model: 'm' } } });
});

test('parseMaxConcurrent / parsePerHarness: one parser for both the delegate and legacy keys', async () => {
  const { parseMaxConcurrent, parsePerHarness } = await import('../extensions/config.ts');
  assert.equal(parseMaxConcurrent(0), 0);
  assert.equal(parseMaxConcurrent(3), 3);
  assert.equal(parseMaxConcurrent(-1), undefined);
  assert.equal(parseMaxConcurrent('4'), undefined);
  assert.equal(parseMaxConcurrent(null), undefined);
  assert.equal(parseMaxConcurrent({}), undefined);
  assert.deepEqual(parseMaxConcurrent({ global: 2 }), { global: 2 });
  assert.deepEqual(parseMaxConcurrent({ global: -2, perHarness: { claude: 1, codex: -1, amp: 'x' } }), {
    perHarness: { claude: 1 },
  });
  assert.equal(parseMaxConcurrent({ global: 'x', perHarness: { codex: -1 } }), undefined);
  assert.equal(parsePerHarness(undefined), undefined);
  assert.equal(parsePerHarness({ claude: -1 }), undefined);
  assert.deepEqual(parsePerHarness({ claude: 0, codex: 2 }), { claude: 0, codex: 2 });
});
