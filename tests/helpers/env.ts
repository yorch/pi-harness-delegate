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
