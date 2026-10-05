import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { test } from 'node:test';
import { agentDir } from '../extensions/config.ts';
import { withEnv } from './helpers/env.ts';
import { PRELOAD_AGENT_DIR_PREFIX } from './helpers/preload.ts';

// The preload (tests/helpers/preload.ts, wired in bunfig.toml) pins PI_CODING_AGENT_DIR to a temp dir for
// the whole `bun test` process — except under the opt-in live suite, which keeps the outer env.
const LIVE = process.env.PI_DELEGATE_LIVE === '1';

test('preload: bunfig.toml wires the preload into bun test', () => {
  const bunfig = readFileSync(join(import.meta.dirname, '..', 'bunfig.toml'), 'utf8');
  assert.match(bunfig, /preload\s*=\s*\[[^\]]*"\.\/tests\/helpers\/preload\.ts"/);
});

test('preload: with no per-test override, agentDir() is a temp dir, never the real ~/.pi/agent', { skip: LIVE }, () => {
  const dir = agentDir();
  assert.equal(dir, process.env.PI_CODING_AGENT_DIR);
  assert.ok(existsSync(dir), `pinned agent dir should exist: ${dir}`);
  assert.ok(basename(dir).startsWith(PRELOAD_AGENT_DIR_PREFIX), dir);
  assert.ok(realpathSync(dir).startsWith(realpathSync(tmpdir()) + sep), `${dir} is not under os.tmpdir()`);
  assert.notEqual(dir, join(homedir(), '.pi', 'agent'));
});

test('preload: withEnv restores PI_CODING_AGENT_DIR to the pinned value, not to unset', { skip: LIVE }, async () => {
  const pinned = process.env.PI_CODING_AGENT_DIR;
  assert.ok(pinned);

  await withEnv({ PI_CODING_AGENT_DIR: '/tmp/some-test-override' }, () => {
    assert.equal(agentDir(), '/tmp/some-test-override');
  });
  assert.equal(process.env.PI_CODING_AGENT_DIR, pinned);

  // Even a test that explicitly unsets it gets the pinned value back afterwards.
  await withEnv({ PI_CODING_AGENT_DIR: undefined }, () => {
    assert.equal('PI_CODING_AGENT_DIR' in process.env, false);
  });
  assert.equal(process.env.PI_CODING_AGENT_DIR, pinned);

  await assert.rejects(
    withEnv({ PI_CODING_AGENT_DIR: '/tmp/another-override' }, () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(process.env.PI_CODING_AGENT_DIR, pinned);
});
