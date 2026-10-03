import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivityEvent, ParseState } from '../extensions/harnesses/types.ts';
import { appendActivities, appendStreamed, MAX_ACTIVITIES, MAX_STREAMED_CHARS } from '../extensions/stream-caps.ts';

const fresh = (): ParseState => ({ streamedText: '', activities: [], result: null });

test('stream caps: the shared limits are the documented 5MB / 5000', () => {
  assert.equal(MAX_STREAMED_CHARS, 5 * 1024 * 1024);
  assert.equal(MAX_ACTIVITIES, 5000);
});

test('appendStreamed: appends and forwards under the cap', () => {
  const state = fresh();
  const seen: string[] = [];
  assert.equal(
    appendStreamed(state, 'abc', c => seen.push(c), 10),
    'abc',
  );
  assert.equal(
    appendStreamed(state, 'de', c => seen.push(c), 10),
    'de',
  );
  assert.equal(state.streamedText, 'abcde');
  assert.deepEqual(seen, ['abc', 'de']);
  assert.equal(appendStreamed(state, ''), null, 'empty chunk is a no-op');
});

test('appendStreamed: truncates the chunk that crosses the cap, then drops everything after', () => {
  const state = fresh();
  const seen: string[] = [];
  appendStreamed(state, '1234567', c => seen.push(c), 10);
  assert.equal(
    appendStreamed(state, 'abcdef', c => seen.push(c), 10),
    'abc [truncated 3 chars]',
  );
  assert.equal(state.streamedText, '1234567abc [truncated 3 chars]');
  assert.equal(
    appendStreamed(state, 'more', c => seen.push(c), 10),
    null,
  );
  assert.equal(state.streamedText, '1234567abc [truncated 3 chars]');
  assert.deepEqual(seen, ['1234567', 'abc [truncated 3 chars]'], 'only what was kept is forwarded');
});

test('appendActivities: keeps and forwards up to the cap, then drops', () => {
  const state = fresh();
  const seen: ActivityEvent[] = [];
  const ev = (n: number): ActivityEvent => ({ kind: 'tool_start', name: `t${n}` });
  appendActivities(state, [ev(1), ev(2)], a => seen.push(a), 3);
  appendActivities(state, [ev(3), ev(4), ev(5)], a => seen.push(a), 3);
  assert.deepEqual(
    state.activities.map(a => (a.kind === 'tool_start' ? a.name : '')),
    ['t1', 't2', 't3'],
  );
  assert.equal(seen.length, 3);
});
