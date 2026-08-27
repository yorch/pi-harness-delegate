import assert from 'node:assert/strict';
import { test } from 'node:test';
import { joinBatch, NotifyBatcher } from '../extensions/notify.ts';

test('joinBatch: a single line passes through unchanged', () => {
  assert.equal(joinBatch(['claude review — 3 turn(s)']), 'claude review — 3 turn(s)');
});

test('joinBatch: multiple lines are combined into one message', () => {
  const text = joinBatch(['claude review — 3 turn(s)', 'codex review — 1 turn(s)']);
  assert.equal(text, '2 runs completed:\n  · claude review — 3 turn(s)\n  · codex review — 1 turn(s)');
});

test('NotifyBatcher: two successes close together flush as one notification', async () => {
  const calls: { text: string; level: string }[] = [];
  const batcher = new NotifyBatcher((text, level) => calls.push({ text, level }), 20);
  batcher.success('claude ok');
  batcher.success('codex ok');
  assert.equal(calls.length, 0, 'nothing emitted before the debounce window elapses');
  await new Promise(r => setTimeout(r, 60));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].level, 'info');
  assert.equal(calls[0].text, joinBatch(['claude ok', 'codex ok']));
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
