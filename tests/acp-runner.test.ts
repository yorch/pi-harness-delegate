import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acpView, runAcpHarness } from '../extensions/acp-runner.ts';
import { devinHarness } from '../extensions/harnesses/devin.ts';
import type { Harness } from '../extensions/harnesses/types.ts';
import { readPid, waitForProcessExit } from './helpers/wait.ts';

/**
 * A fake ACP agent (spawned via `node -e <script>`, not the real `devin` binary) that speaks the
 * same JSON-RPC wire format devin.ts parses, so these tests exercise the real `runAcpHarness` +
 * `devinHarness.parseLine` pipeline deterministically and without a billed `devin` run. `mode`
 * selects the scripted behavior; `pidFile` lets a test observe whether the child was actually killed.
 */
const FAKE_AGENT_SCRIPT = `
const readline = require('node:readline');
const fs = require('node:fs');
const [, mode, pidFile] = process.argv;
// flood-tools reuses the pidFile slot for its event count
if (pidFile && mode !== 'flood-tools') fs.writeFileSync(pidFile, String(process.pid));
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    const protocolVersion = mode === 'protocol-mismatch' ? 2 : 1;
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion, agentCapabilities: {} } });
    return;
  }
  // a response to a request *we* (the fake agent) sent — echo what the client answered as message
  // text, then finish the pending prompt, so a test can assert on the client's reply
  if (msg.id === 'srv-1' && !msg.method) {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(msg.result ?? { error: msg.error }) } } } });
    send({ jsonrpc: '2.0', id: global.promptId, result: { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0 } } });
    return;
  }
  if (msg.method === 'session/new') {
    if (mode === 'hang-new') return; // never answers — only the handshake timeout ends this
    if (mode === 'fail-handshake') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'boom' } });
    } else if (mode === 'no-modes') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'fake-session' } });
    } else if (mode === 'config-modes') {
      // opencode's dialect: no \`modes\` field, a configOptions entry with category "mode" instead
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'fake-session', configOptions: [{ id: 'mode', category: 'mode', type: 'select', currentValue: 'build', options: [] }] } });
    } else {
      // Real Devin/opencode/omp all advertise mode support one way or another on session/new —
      // see supportsSessionModes()'s two dialects (docs/acp-harness-assessment.md §4).
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'fake-session', modes: {} } });
    }
    return;
  }
  if (msg.method === 'session/load') {
    // Replay a whole prior turn as notifications before responding — the real Devin behavior
    // that Finding 3 fixes the runner against.
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD REPLAYED ANSWER' } } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'tool_call', toolCallId: 'replay-1', kind: 'read', rawInput: {} } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'tool_call_update', toolCallId: 'replay-1', status: 'completed' } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { modes: {} } });
    return;
  }
  if (msg.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/prompt') {
    if (mode === 'hang-prompt') return; // the turn never ends — only timeout/abort can stop it
    if (mode === 'perm-reject' || mode === 'perm-none' || mode === 'fs-read') {
      global.promptId = msg.id;
      if (mode === 'fs-read') {
        send({ jsonrpc: '2.0', id: 'srv-1', method: 'fs/read_text_file', params: { sessionId: 'fake-session', path: '/etc/passwd' } });
      } else {
        const options = mode === 'perm-reject'
          ? [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'nope-always', kind: 'reject_always', name: 'Never' }, { optionId: 'nope', kind: 'reject_once', name: 'No' }]
          : [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'allow-all', kind: 'allow_always', name: 'Always' }];
        send({ jsonrpc: '2.0', id: 'srv-1', method: 'session/request_permission', params: { sessionId: 'fake-session', toolCall: { toolCallId: 'w1' }, options } });
      }
      return;
    }
    if (mode === 'flood-text' || mode === 'flood-tools') {
      // an agent streaming without bound — the runner's caps (stream-caps.ts) must hold
      const update = (u) => JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: u } }) + '\\n';
      let out = '';
      if (mode === 'flood-text') {
        const chunk = 'x'.repeat(1024 * 1024 + 7); // not a divisor of 5MB, so one chunk straddles the cap
        for (let i = 0; i < 7; i++) out += update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
      } else {
        for (let i = 0; i < Number(pidFile); i++) out += update({ sessionUpdate: 'tool_call', toolCallId: 't' + i, kind: 'read', rawInput: {} });
      }
      process.stdout.write(out, () => send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }));
      return;
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'tool_call', toolCallId: 'real-1', kind: 'read', rawInput: {} } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'tool_call_update', toolCallId: 'real-1', status: 'completed' } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'NEW ANSWER' } } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0 } } });
    return;
  }
});
`;

function fakeHarness(mode: string, pidFile?: string): Harness {
  return {
    ...devinHarness,
    binary: process.execPath,
    buildArgs: () => (pidFile ? ['-e', FAKE_AGENT_SCRIPT, mode, pidFile] : ['-e', FAKE_AGENT_SCRIPT, mode]),
  };
}

function tmpPidFile(name: string): string {
  // its own fresh mkdtemp dir — unique by construction, no clock/random collision
  return join(mkdtempSync(join(tmpdir(), `acp-runner-test-${name}-`)), 'agent.pid');
}

test('acpView: falls back to stdout-shaped fields for an ACP-only harness (Devin needs zero changes)', () => {
  const view = acpView(devinHarness);
  assert.equal(view.buildArgs, devinHarness.buildArgs);
  assert.equal(view.parseLine, devinHarness.parseLine);
  assert.equal(view.permissionMap, devinHarness.permissionMap);
});

test('acpView: prefers the Acp-prefixed fields for a dual-transport harness', () => {
  const buildAcpArgs = () => ['acp'];
  const parseAcpLine = () => ({});
  const acpPermissionMap = { readonly: ['plan'], edit: ['build'], danger: ['build'] };
  const dual: Harness = { ...devinHarness, buildAcpArgs, parseAcpLine, acpPermissionMap };
  const view = acpView(dual);
  assert.equal(view.buildArgs, buildAcpArgs);
  assert.equal(view.parseLine, parseAcpLine);
  assert.equal(view.permissionMap, acpPermissionMap);
});

test('runAcpHarness: a rejected handshake step kills the child process (Finding 1)', async () => {
  const pidFile = tmpPidFile('fail-handshake');
  const harness = fakeHarness('fail-handshake', pidFile);

  await assert.rejects(
    runAcpHarness({ harness, prompt: 'hi', cwd: process.cwd(), permission: 'readonly', timeoutMs: 10_000 }),
  );

  // The fake agent writes its own pid before doing anything else, then just answers JSON-RPC —
  // it never exits on its own. If the catch handler didn't kill it, this process would still be alive.
  // By the time runAcpHarness's promise has rejected, the child has already round-tripped
  // initialize + session/new, so the pid file is guaranteed to exist.
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(Number.isInteger(pid) && pid > 0, `expected a real pid, got ${pid}`);
  const exited = await waitForProcessExit(pid);
  assert.ok(exited, `child process ${pid} was not killed after a rejected handshake step`);
});

test('runAcpHarness: resume discards replayed text/activity before the new prompt (Finding 3)', async () => {
  const harness = fakeHarness('replay');
  let streamed = '';
  const activityIds: string[] = [];

  const result = await runAcpHarness({
    harness,
    prompt: 'continue',
    cwd: process.cwd(),
    permission: 'readonly',
    timeoutMs: 10_000,
    resumeSessionId: 'fake-session',
    onStream: t => {
      streamed += t;
    },
    onActivity: ev => {
      if ((ev.kind === 'tool_input' || ev.kind === 'tool_result') && ev.id) activityIds.push(ev.id);
    },
  });

  assert.equal(result.streamedText, 'NEW ANSWER');
  assert.ok(!result.streamedText.includes('OLD REPLAYED'), result.streamedText);
  assert.equal(streamed, 'NEW ANSWER');
  assert.ok(!streamed.includes('OLD REPLAYED'), streamed);
  assert.deepEqual(activityIds, ['real-1', 'real-1']); // tool_input + tool_result for the real turn only
  assert.ok(result.result.includes('NEW ANSWER'));
  assert.ok(!result.result.includes('OLD REPLAYED'));
});

test('runAcpHarness: a protocolVersion mismatch on initialize fails clearly (docs/acp-protocol-research.md §4/§8)', async () => {
  const harness = fakeHarness('protocol-mismatch');
  await assert.rejects(
    runAcpHarness({ harness, prompt: 'hi', cwd: process.cwd(), permission: 'readonly', timeoutMs: 10_000 }),
    /protocolVersion/,
  );
});

test('runAcpHarness: an agent that never advertises session-mode support fails instead of running unconstrained', async () => {
  const harness = fakeHarness('no-modes');
  await assert.rejects(
    runAcpHarness({ harness, prompt: 'hi', cwd: process.cwd(), permission: 'readonly', timeoutMs: 10_000 }),
    /session-mode support/,
  );
});

test('runAcpHarness: writing to an agent that already exited fails the run cleanly (stdin EPIPE is handled)', async () => {
  // closes its stdin, then answers initialize and lingers briefly — the runner's next write
  // (session/new) lands on a pipe with no reader. Whether that surfaces as an async EPIPE 'error'
  // event is runtime/timing dependent (bun doesn't reliably emit one here), so this is a smoke test
  // that the run fails cleanly either way. The guard itself is pinned by the injected-EPIPE test below.
  const script =
    "process.stdin.once('data', d => { const m = JSON.parse(String(d).split('\\n')[0]); process.stdin.destroy(); " +
    "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } }) + '\\n'); " +
    'setTimeout(() => process.exit(0), 300); });';
  const harness: Harness = { ...devinHarness, binary: process.execPath, buildArgs: () => ['-e', script] };
  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      runAcpHarness({ harness, prompt: 'hi', cwd: process.cwd(), permission: 'readonly', timeoutMs: 10_000 }),
      /exited|finished without|session ended/,
    );
  }
});

test('runAcpHarness: an async stdin error (EPIPE) mid-handshake never escapes as an unhandled error', async () => {
  // bun doesn't emit EPIPE for a real closed pipe (the smoke test above), so inject it: the real
  // fake agent is spawned, and the runner's first stdin write is answered with the exact async
  // 'error' event node emits for EPIPE. Without the runner's stdin 'error' listener, EventEmitter
  // throws it as an uncaught exception, which the guard below turns into a test failure.
  const { spawn } = await import('node:child_process');
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  const prevListeners = process.listeners('uncaughtException').filter(l => l !== onUncaught);
  for (const l of prevListeners) process.off('uncaughtException', l);
  let injected = false;
  const spawnWithEpipe = ((...a: Parameters<typeof spawn>) => {
    const proc = spawn(...a);
    const write = proc.stdin?.write.bind(proc.stdin);
    if (proc.stdin && write) {
      proc.stdin.write = ((chunk: unknown, ...rest: never[]) => {
        if (!injected) {
          injected = true;
          const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' });
          setImmediate(() => proc.stdin?.emit('error', err));
        }
        return write(chunk as string, ...rest);
      }) as typeof proc.stdin.write;
    }
    return proc;
  }) as typeof spawn;
  try {
    const res = await runAcpHarness(
      { harness: fakeHarness('default'), prompt: 'hi', cwd: process.cwd(), permission: 'readonly', timeoutMs: 20_000 },
      { spawn: spawnWithEpipe },
    );
    // the run itself is unaffected: the agent still answered over a pipe that only *reported* an error
    assert.equal(res.streamedText, 'NEW ANSWER');
  } finally {
    process.off('uncaughtException', onUncaught);
    for (const l of prevListeners) process.on('uncaughtException', l);
  }
  assert.ok(injected, 'the EPIPE was injected');
  assert.deepEqual(uncaught, [], 'stdin EPIPE escaped as an uncaught exception');
});

test('runAcpHarness: a successful run resolves and kills the agent itself (ACP agents never exit on their own)', async () => {
  const pidFile = tmpPidFile('success');
  // the fake agent never exits by itself — resolving at all proves the runner didn't wait for 'close'
  const res = await runAcpHarness({
    harness: fakeHarness('default', pidFile),
    prompt: 'hi',
    cwd: process.cwd(),
    permission: 'readonly',
    timeoutMs: 20_000,
  });
  assert.equal(res.streamedText, 'NEW ANSWER');
  assert.equal(res.isError, false);
  assert.ok(await waitForProcessExit(await readPid(pidFile)), 'agent process must be killed after success');
});

test('runAcpHarness: the overall timeout kills a hung turn', async () => {
  const pidFile = tmpPidFile('timeout');
  await assert.rejects(
    runAcpHarness({
      harness: fakeHarness('hang-prompt', pidFile),
      prompt: 'hi',
      cwd: process.cwd(),
      permission: 'readonly',
      timeoutMs: 500,
    }),
    /timed out after 500ms/,
  );
  assert.ok(await waitForProcessExit(await readPid(pidFile)), 'agent process must be killed on timeout');
});

test('runAcpHarness: aborting the signal mid-turn kills the agent and rejects as cancelled', async () => {
  const pidFile = tmpPidFile('abort');
  const ac = new AbortController();
  const run = runAcpHarness({
    harness: fakeHarness('hang-prompt', pidFile),
    prompt: 'hi',
    cwd: process.cwd(),
    permission: 'readonly',
    timeoutMs: 20_000,
    signal: ac.signal,
  });
  const pid = await readPid(pidFile);
  ac.abort();
  await assert.rejects(run, /cancelled/);
  assert.ok(await waitForProcessExit(pid), 'agent process must be killed on abort');
});

test('runAcpHarness: a hung handshake step fails at the handshake timeout, not the overall one, and kills the agent', async () => {
  const pidFile = tmpPidFile('hang-new');
  const started = Date.now();
  await assert.rejects(
    runAcpHarness(
      {
        harness: fakeHarness('hang-new', pidFile),
        prompt: 'hi',
        cwd: process.cwd(),
        permission: 'readonly',
        timeoutMs: 60_000,
      },
      { handshakeTimeoutMs: 300 },
    ),
    /session\/new timed out after 300ms/,
  );
  assert.ok(Date.now() - started < 10_000, 'must not wait for the overall timeoutMs');
  assert.ok(await waitForProcessExit(await readPid(pidFile)), 'agent process must be killed');
});

test('runAcpHarness: session/request_permission is answered with a reject option, preferring reject_once', async () => {
  const res = await runAcpHarness({
    harness: fakeHarness('perm-reject'),
    prompt: 'hi',
    cwd: process.cwd(),
    permission: 'edit',
    timeoutMs: 20_000,
  });
  assert.deepEqual(JSON.parse(res.streamedText), { outcome: { outcome: 'selected', optionId: 'nope' } });
});

test('runAcpHarness: session/request_permission with no reject option is answered cancelled, never allowed', async () => {
  const res = await runAcpHarness({
    harness: fakeHarness('perm-none'),
    prompt: 'hi',
    cwd: process.cwd(),
    permission: 'edit',
    timeoutMs: 20_000,
  });
  assert.deepEqual(JSON.parse(res.streamedText), { outcome: { outcome: 'cancelled' } });
});

test('runAcpHarness: any other server-initiated request gets a JSON-RPC error (no fs/terminal proxying)', async () => {
  const res = await runAcpHarness({
    harness: fakeHarness('fs-read'),
    prompt: 'hi',
    cwd: process.cwd(),
    permission: 'edit',
    timeoutMs: 20_000,
  });
  const reply = JSON.parse(res.streamedText) as { error: { code: number; message: string } };
  assert.equal(reply.error.code, -32601);
  assert.match(reply.error.message, /fs\/read_text_file not supported/);
});

test('runAcpHarness: a configOptions "mode" category is accepted as session-mode support (opencode dialect)', async () => {
  const res = await runAcpHarness({
    harness: fakeHarness('config-modes'),
    prompt: 'hi',
    cwd: process.cwd(),
    permission: 'readonly',
    timeoutMs: 20_000,
  });
  assert.equal(res.streamedText, 'NEW ANSWER');
});

test('runAcpHarness: streamed text is capped at 5MB with a truncation marker, and only kept text is forwarded', async () => {
  const { MAX_STREAMED_CHARS } = await import('../extensions/stream-caps.ts');
  let forwarded = 0;
  const res = await runAcpHarness({
    harness: fakeHarness('flood-text'),
    prompt: 'hi',
    cwd: process.cwd(),
    permission: 'readonly',
    timeoutMs: 30_000,
    onStream: t => {
      forwarded += t.length;
    },
  });
  assert.ok(res.streamedText.startsWith('x'.repeat(1000)));
  assert.match(res.streamedText, /\[truncated \d+ chars\]$/);
  assert.equal(res.streamedText.replace(/ \[truncated \d+ chars\]$/, '').length, MAX_STREAMED_CHARS);
  assert.equal(forwarded, res.streamedText.length, 'onStream sees exactly what was kept');
});

test('runAcpHarness: activities are capped at 5000 (stored and forwarded)', async () => {
  const { MAX_ACTIVITIES } = await import('../extensions/stream-caps.ts');
  let forwarded = 0;
  await runAcpHarness({
    harness: fakeHarness('flood-tools', String(MAX_ACTIVITIES + 250)),
    prompt: 'hi',
    cwd: process.cwd(),
    permission: 'readonly',
    timeoutMs: 30_000,
    onActivity: () => {
      forwarded++;
    },
  });
  assert.equal(forwarded, MAX_ACTIVITIES);
});
