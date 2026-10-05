/**
 * Minimal ambient types for the `bun:test` hooks tests/helpers/preload.ts registers. The repo has no
 * `bun-types` dev dependency (tests are written against `node:test`, which bun implements), so this
 * declares only what the preload uses.
 *
 * Why the preload uses `bun:test` rather than `node:test` for these: under bun 1.3.14 (the version
 * `package.json`'s `packageManager` pins, and so the one CI runs) a throw from a `node:test` `afterEach`
 * registered in a preload does not fail the test it ran after — it is reported as an "Unhandled error
 * between tests" and every test still counts as passed. A `bun:test` hook registered in a preload applies
 * to every test (`node:test` ones included) and fails the right test on both 1.3.14 and 1.4.x. The
 * preload's `afterAll` (pinned-dir cleanup) is there because bun 1.3.14 never emits `process` `'exit'` at
 * the end of `bun test`; a `bun:test` `afterAll` in a preload runs once, after the last file.
 */
declare module 'bun:test' {
  export function afterEach(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
}
