import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Condition-based wait: resolves as soon as `check()` returns a non-undefined value, re-checking
 * once per event-loop turn (plus a tiny backoff so a long wait doesn't spin a core). The deadline
 * is only a hang guard — generous on purpose, so a slow/loaded CI box never turns a passing
 * condition into a flaky failure; a test that passes finishes the moment its condition holds.
 */
export async function waitFor<T>(
  check: () => T | undefined,
  { timeoutMs = 15_000, label = 'condition' }: { timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (let turn = 0; ; turn++) {
    const v = check();
    if (v !== undefined) return v;
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(r => (turn < 50 ? setImmediate(r) : setTimeout(r, 5)));
  }
}

/** True once `pid` no longer exists (ESRCH). Rejects (via the hang guard) if it never exits. Only
 *  ESRCH means gone — EPERM means the pid exists but isn't ours to signal, i.e. still alive. */
export async function waitForProcessExit(pid: number, timeoutMs?: number): Promise<boolean> {
  return waitFor(
    () => {
      try {
        process.kill(pid, 0); // still alive
        return undefined;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return true; // gone
        if (code === 'EPERM') return undefined; // exists, owned by someone else — alive
        throw err;
      }
    },
    { timeoutMs, label: `process ${pid} to exit` },
  );
}

/** The pid a fake child wrote to `pidFile`, once it has been written. */
export async function readPid(pidFile: string, timeoutMs?: number): Promise<number> {
  return waitFor(
    () => {
      try {
        const pid = Number(readFileSync(pidFile, 'utf8'));
        return Number.isInteger(pid) && pid > 0 ? pid : undefined;
      } catch {
        return undefined; // not written yet
      }
    },
    { timeoutMs, label: `a pid in ${pidFile}` },
  );
}

/**
 * True once no running process has `marker` anywhere in its command line (`ps -A -ww`). For a child
 * that may be killed before it ever gets to write its pid file (e.g. a short runner timeout on a
 * loaded machine) — `readPid` would then wait for a file that never appears. `marker` must be unique
 * to that child's argv (a fresh `mkdtemp` path is). A zombie no longer shows its args, so it counts
 * as gone.
 */
export async function waitForNoProcessWithArg(marker: string, timeoutMs?: number): Promise<boolean> {
  return waitFor(
    () => {
      const ps = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,command='], { encoding: 'utf8' });
      const alive = ps.split('\n').filter(line => line.includes(marker) && !line.includes('<defunct>'));
      return alive.length === 0 ? true : undefined;
    },
    { timeoutMs, label: `no process with ${marker} in its argv` },
  );
}
