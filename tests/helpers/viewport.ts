import { test } from 'node:test';

/** Run `fn` with `process.stdout.columns` / `.rows` set — the terminal the confirmation layout reads (restored after, even on a throw). */
export async function withViewport<T>(
  columns: number | undefined,
  rows: number | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  const saved = { columns: process.stdout.columns, rows: process.stdout.rows };
  const set = (k: 'columns' | 'rows', v: number | undefined): void => {
    Object.defineProperty(process.stdout, k, { value: v, configurable: true, writable: true });
  };
  set('columns', columns);
  set('rows', rows);
  try {
    return await fn();
  } finally {
    set('columns', saved.columns);
    set('rows', saved.rows);
  }
}

/**
 * `node:test`'s `test`, run on a pinned 80x40 terminal — for the test files whose dialogs are not about the
 * terminal's size. (An unknown size is taken to be 80x24; a test that cares sets its own with `withViewport`.)
 */
export function testAt80x40(name: string, fn: () => unknown): void {
  test(name, async () => {
    await withViewport(80, 40, async () => fn());
  });
}
