import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type BatcherTimers, joinBatch, NotifyBatcher } from '../extensions/notify.ts';

/** A manual clock: timers fire only when `advance()` moves time past their deadline. */
function fakeTimers(): BatcherTimers & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    set(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clear(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue;
        timers.delete(id);
        t.fn();
      }
    },
    pending: () => timers.size,
  };
}

test('joinBatch: a single line passes through unchanged', () => {
  assert.equal(joinBatch(['claude review — 3 turn(s)']), 'claude review — 3 turn(s)');
});

test('joinBatch: multiple lines are combined into one message', () => {
  const text = joinBatch(['claude review — 3 turn(s)', 'codex review — 1 turn(s)']);
  assert.equal(text, '2 runs completed:\n  · claude review — 3 turn(s)\n  · codex review — 1 turn(s)');
});

test('NotifyBatcher: two successes close together flush as one notification', () => {
  const calls: { text: string; level: string }[] = [];
  const clock = fakeTimers();
  const batcher = new NotifyBatcher((text, level) => calls.push({ text, level }), 20, clock);
  batcher.success('claude ok');
  clock.advance(15);
  batcher.success('codex ok'); // inside the window: re-arms the debounce
  clock.advance(15);
  assert.equal(calls.length, 0, 'nothing emitted before the debounce window elapses');
  assert.equal(clock.pending(), 1, 'one debounce timer, re-armed rather than stacked');
  clock.advance(5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].level, 'info');
  assert.equal(calls[0].text, joinBatch(['claude ok', 'codex ok']));
  assert.equal(clock.pending(), 0);
});

test('NotifyBatcher: the default timers really fire after the debounce', async () => {
  const text = await new Promise<string>(resolve => {
    const b = new NotifyBatcher(text => resolve(text), 1);
    b.success('claude ok');
  });
  assert.equal(text, 'claude ok');
});

test('NotifyBatcher: a failure is never delayed and flushes any pending batch first', () => {
  const calls: { text: string; level: string }[] = [];
  const batcher = new NotifyBatcher((text, level) => calls.push({ text, level }), 1000);
  batcher.success('claude ok');
  batcher.failure('codex failed: timeout');
  assert.equal(calls.length, 2, 'the pending success batch flushes, then the failure emits immediately');
  assert.equal(calls[0].text, 'claude ok');
  assert.equal(calls[0].level, 'info');
  assert.equal(calls[1].text, 'codex failed: timeout');
  assert.equal(calls[1].level, 'error');
});

test('NotifyBatcher: explicit flush emits nothing when the batch is empty', () => {
  const calls: unknown[] = [];
  const batcher = new NotifyBatcher(() => calls.push(1));
  batcher.flush();
  assert.equal(calls.length, 0);
});

test('NotifyBatcher: explicit flush surfaces a pending success immediately, without waiting', () => {
  const calls: { text: string; level: string }[] = [];
  const batcher = new NotifyBatcher((text, level) => calls.push({ text, level }), 1000);
  batcher.success('claude ok');
  batcher.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'claude ok');
});
