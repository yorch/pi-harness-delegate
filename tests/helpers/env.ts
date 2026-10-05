/**
 * The one place tests mutate `process.env`. Never restore a saved value with a bare
 * `process.env.X = prev`: when `X` was unset, `prev` is `undefined`, and assigning `undefined` to
 * `process.env` stores the *string* `"undefined"` (Node and Bun both coerce). A restored
 * `PI_CODING_AGENT_DIR="undefined"` once made a run that outlived its sandbox write transcripts into a
 * relative `undefined/delegate/outputs/...` directory inside the repo. `tests/env-hygiene.test.ts`
 * fails the suite if any other test file writes to `process.env` directly.
 */

/** Restore `name` to `prev`, deleting it when it was unset (`prev === undefined`). */
export function restoreEnv(name: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

/**
 * Set every entry of `vars` (an `undefined` value unsets that var), run `fn` (sync or async — it is
 * always awaited), then restore each var to exactly its previous state, even when `fn` throws.
 */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.keys(vars).map(name => [name, process.env[name]] as const);
  for (const [name, value] of Object.entries(vars)) restoreEnv(name, value);
  try {
    return await fn();
  } finally {
    for (const [name, prev] of saved) restoreEnv(name, prev);
  }
}

/**
 * Like `withEnv`, but strictly synchronous: `vars` are in effect only while `fn` itself runs, and are
 * restored the moment it returns (or throws) — *before* any promise it returns settles. Use it to hand
 * a different env to a child process only: `spawn`/`execFile` snapshot `process.env` synchronously when
 * called, so `withEnvSync(vars, () => runHarness(opts))` gives the child `vars` (both runners spawn
 * synchronously inside their Promise executor) while this process is back on its own env before the
 * run is even awaited. Anything `fn` does after its first `await` sees the restored env, not `vars`.
 *
 * Why not `withEnv` around a long async run: it restores only once the run settles. If bun's per-test
 * timeout fires first, the next test starts while the swap is still in effect, and two overlapping
 * `withEnv`s then restore out of order — leaving the rest of the process on the swapped value.
 */
export function withEnvSync<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.keys(vars).map(name => [name, process.env[name]] as const);
  for (const [name, value] of Object.entries(vars)) restoreEnv(name, value);
  try {
    return fn();
  } finally {
    for (const [name, prev] of saved) restoreEnv(name, prev);
  }
}
