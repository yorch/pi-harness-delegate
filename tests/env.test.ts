import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { runAcpHarness } from '../extensions/acp-runner.ts';
import { claudeHarness } from '../extensions/harnesses/claude.ts';
import { devinHarness } from '../extensions/harnesses/devin.ts';
import type { Harness } from '../extensions/harnesses/types.ts';
import { runHarness } from '../extensions/runner.ts';
import { restoreEnv, withEnv, withEnvSync } from './helpers/env.ts';

// Direct tests for the one helper every env write in tests goes through. Each uses its own var name,
// unset in the outer env, so the delete-when-unset branch is what's under test.
const fresh = (name: string): string => {
  assert.equal(name in process.env, false, `${name} must start unset for this test`);
  return name;
};

test('restoreEnv: a previously-unset var is deleted, never stored as the string "undefined"', () => {
  const name = fresh('ZZ_ENV_TEST_RESTORE');
  restoreEnv(name, 'x');
  assert.equal(process.env[name], 'x');
  restoreEnv(name, undefined);
  assert.equal(name in process.env, false);
  assert.notEqual(process.env[name], 'undefined');
});

test('withEnv: a var that was unset before is removed again afterwards', async () => {
  const name = fresh('ZZ_ENV_TEST_UNSET');
  const seen = await withEnv({ [name]: 'x' }, () => process.env[name]);
  assert.equal(seen, 'x');
  assert.equal(name in process.env, false);
});

test('withEnv: an undefined value unsets the var inside, and the previous value comes back', async () => {
  const name = fresh('ZZ_ENV_TEST_SET_UNDEF');
  await withEnv({ [name]: 'outer' }, async () => {
    await withEnv({ [name]: undefined }, () => {
      assert.equal(name in process.env, false);
    });
    assert.equal(process.env[name], 'outer');
  });
  assert.equal(name in process.env, false);
});

test('withEnv: restores on a sync throw and on an async rejection', async () => {
  const name = fresh('ZZ_ENV_TEST_THROW');
  await assert.rejects(
    withEnv({ [name]: 'x' }, () => {
      throw new Error('sync boom');
    }),
    /sync boom/,
  );
  assert.equal(name in process.env, false);
  await assert.rejects(
    withEnv({ [name]: 'x' }, async () => {
      await Promise.resolve();
      throw new Error('async boom');
    }),
    /async boom/,
  );
  assert.equal(name in process.env, false);
});

test('withEnv: nested calls each restore their own layer, several vars at once', async () => {
  const a = fresh('ZZ_ENV_TEST_NEST_A');
  const b = fresh('ZZ_ENV_TEST_NEST_B');
  await withEnv({ [a]: '1' }, async () => {
    await withEnv({ [a]: '2', [b]: 'b' }, () => {
      assert.equal(process.env[a], '2');
      assert.equal(process.env[b], 'b');
    });
    assert.equal(process.env[a], '1');
    assert.equal(b in process.env, false);
  });
  assert.equal(a in process.env, false);
  assert.equal(b in process.env, false);
});

test('withEnv: returns the callback value', async () => {
  assert.equal(await withEnv({}, () => 42), 42);
  assert.equal(await withEnv({}, async () => 'v'), 'v');
});

test('withEnvSync: in effect only while fn runs, restored on return and on throw', () => {
  const name = fresh('ZZ_ENV_TEST_SYNC');
  assert.equal(
    withEnvSync({ [name]: 'x' }, () => process.env[name]),
    'x',
  );
  assert.equal(name in process.env, false);
  assert.throws(
    () =>
      withEnvSync({ [name]: 'x' }, () => {
        throw new Error('sync boom');
      }),
    /sync boom/,
  );
  assert.equal(name in process.env, false);
});

test('withEnvSync: restores before a returned promise settles — code after its first await sees the old env', async () => {
  const name = fresh('ZZ_ENV_TEST_SYNC_ASYNC');
  const pending = withEnvSync({ [name]: 'x' }, async () => {
    const before = process.env[name];
    await Promise.resolve();
    return [before, process.env[name]];
  });
  assert.equal(name in process.env, false, 'restored as soon as the synchronous call returned');
  assert.deepEqual(await pending, ['x', undefined]);
});

/**
 * The live suite's shape (tests/live.test.ts): `withEnvSync({ PI_CODING_AGENT_DIR: outer }, () => run(...))`
 * then await the run outside the swap. A fake stdout harness (bun -e) reports, after a delay, the
 * PI_CODING_AGENT_DIR it inherited — `ABSENT` when the var is not in its env at all.
 */
const REPORT_AGENT_DIR =
  'setTimeout(() => console.log(JSON.stringify({ type: "result", ' +
  'result: "PI_CODING_AGENT_DIR" in process.env ? "SET:" + process.env.PI_CODING_AGENT_DIR : "ABSENT" })), 200);';
const reportingHarness: Harness = {
  ...claudeHarness,
  binary: process.execPath,
  buildArgs: () => ['-e', REPORT_AGENT_DIR],
};
const SPAWN = { timeout: 60_000 };

for (const [label, outer, expected] of [
  ['unset', undefined, 'ABSENT'],
  ['set', '/tmp/outer-agent-dir', 'SET:/tmp/outer-agent-dir'],
] as const) {
  test(
    `withEnvSync + runHarness: the child gets the ${label} outer value, this process is re-pinned at once`,
    SPAWN,
    async () => {
      const pinned = process.env.PI_CODING_AGENT_DIR;
      assert.ok(pinned, 'the preload pins PI_CODING_AGENT_DIR');
      const pending = withEnvSync({ PI_CODING_AGENT_DIR: outer }, () =>
        runHarness({
          harness: reportingHarness,
          prompt: 'hi',
          cwd: process.cwd(),
          permission: 'readonly',
          timeoutMs: 30_000,
        }),
      );
      assert.equal(process.env.PI_CODING_AGENT_DIR, pinned, 're-pinned before the run is awaited');
      const res = await pending;
      assert.equal(res.isError, false, res.result);
      assert.equal(res.result, expected, 'never the string "undefined" when the outer value was unset');
      assert.equal(process.env.PI_CODING_AGENT_DIR, pinned);
    },
  );
}

test('withEnvSync + runAcpHarness: the ACP runner also spawns inside the synchronous swap', SPAWN, async () => {
  const pinned = process.env.PI_CODING_AGENT_DIR;
  const seen: Array<string | undefined> = [];
  const pending = withEnvSync({ PI_CODING_AGENT_DIR: undefined }, () =>
    runAcpHarness(
      { harness: devinHarness, prompt: 'hi', cwd: process.cwd(), permission: 'readonly', timeoutMs: 30_000 },
      {
        // record the env the real spawn would snapshot, then start a child that exits straight away
        spawn: ((..._args: unknown[]) => {
          seen.push('PI_CODING_AGENT_DIR' in process.env ? process.env.PI_CODING_AGENT_DIR : 'ABSENT');
          return spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'pipe', 'pipe'] });
        }) as typeof spawn,
        handshakeTimeoutMs: 10_000,
      },
    ),
  );
  assert.deepEqual(seen, ['ABSENT'], 'spawned synchronously, while the outer (unset) value was in effect');
  assert.equal(process.env.PI_CODING_AGENT_DIR, pinned);
  await pending.catch(() => {}); // the stand-in child exits before any handshake — irrelevant here
});
