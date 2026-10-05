import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restoreEnv, withEnv } from './helpers/env.ts';

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
