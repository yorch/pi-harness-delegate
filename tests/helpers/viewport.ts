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
