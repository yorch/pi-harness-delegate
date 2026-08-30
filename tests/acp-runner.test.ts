import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAcpHarness } from '../extensions/acp-runner.ts';
import { devinHarness } from '../extensions/harnesses/devin.ts';
import type { Harness } from '../extensions/harnesses/types.ts';

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
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === 'session/new') {
    if (mode === 'fail-handshake') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'boom' } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'fake-session' } });
    }
    return;
  }
  if (msg.method === 'session/load') {
    // Replay a whole prior turn as notifications before responding — the real Devin behavior
    // that Finding 3 fixes the runner against.
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD REPLAYED ANSWER' } } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'tool_call', toolCallId: 'replay-1', kind: 'read', rawInput: {} } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'tool_call_update', toolCallId: 'replay-1', status: 'completed' } } });
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/prompt') {
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
  return join(tmpdir(), `acp-runner-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`);
}

async function waitForProcessExit(pid: number, timeoutMs = 1000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0); // still alive
    } catch {
      return true; // ESRCH — process is gone
    }
    await new Promise(r => setTimeout(r, 10));
  }
  return false;
}

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
