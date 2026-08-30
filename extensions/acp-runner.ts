/**
 * Sibling to runner.ts for harnesses whose `transport` is `'acp'` (Agent Client Protocol,
 * https://agentclientprotocol.com — JSON-RPC 2.0, newline-delimited, over stdio). Unlike the
 * stdout harnesses' one-way JSONL stream, ACP is bidirectional and stateful: the runner must
 * drive a handshake (`initialize` -> `session/new` -> `session/set_mode` -> `session/prompt`)
 * and hold stdin open for the session's lifetime — the agent exits on stdin EOF. It must also
 * answer requests the agent sends back to us (permission prompts, fs reads) so the session
 * doesn't hang, since we run non-interactively with a permission mode already negotiated.
 *
 * Exposes the exact `RunHarnessOptions`/`HarnessResult` shape as runner.ts, so `delegate()`
 * can pick either runner from the resolved `transport` (see config.ts's `resolveTransport`) and
 * everything downstream (transcripts, `ToolCallIndex`, progress overlays, fan-out, spend rollup)
 * is unchanged.
 *
 * Deliberately general: an agent's mode ids and result shape live in its `Harness` (`buildArgs`/
 * `buildAcpArgs`, `permissionMap`/`acpPermissionMap`, `parseLine`/`parseAcpLine`, `extractResult`)
 * — this file only knows the ACP wire protocol. Callers driving a dual-transport harness over ACP
 * pass it through `acpView()` (below) first, so this file always reads the stdout-shaped field
 * names regardless of which harness it's given.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DEFAULT_TIMEOUT_MS, type Harness, type ParseState, type StreamedResult } from './harnesses/types.ts';
import type { HarnessResult, RunHarnessOptions } from './runner.ts';

/** Bound on the initial handshake (initialize / session/new / session/set_mode) so a hung agent
 *  doesn't wedge the whole `timeoutMs` budget before `session/prompt` — the actual work — even starts. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

const PROTOCOL_VERSION = 1;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Presents the ACP-shaped view of a dual-transport `Harness` (buildAcpArgs/parseAcpLine/
 *  acpPermissionMap) to this file, falling back to the stdout-shaped fields for an ACP-only
 *  harness like Devin that never declares the Acp-prefixed ones. Devin needs zero changes for
 *  this — every field below already exists on it under the stdout-shaped name. */
export function acpView(harness: Harness): Harness {
  return {
    ...harness,
    buildArgs: harness.buildAcpArgs ?? harness.buildArgs,
    parseLine: harness.parseAcpLine ?? harness.parseLine,
    permissionMap: harness.acpPermissionMap ?? harness.permissionMap,
  };
}

/** Does this `session/new`/`session/load` result advertise support for switching session modes?
 *  Two independently-real dialects, both live-verified (docs/acp-harness-assessment.md §2/§4):
 *  the spec-standard `modes` field (Devin, omp), or a `configOptions` entry with `category: "mode"`
 *  (opencode, which never populates `modes` at all but implements `session/set_mode` anyway). Either
 *  signal is enough to trust the upcoming `session/set_mode` call. */
function supportsSessionModes(sessionResult: unknown): boolean {
  if (!isRecord(sessionResult)) return false;
  if (isRecord(sessionResult.modes)) return true;
  if (Array.isArray(sessionResult.configOptions)) {
    return sessionResult.configOptions.some(o => isRecord(o) && o.category === 'mode');
  }
  return false;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export function runAcpHarness(opts: RunHarnessOptions): Promise<HarnessResult> {
  return new Promise((resolve, reject) => {
    const args = opts.harness.buildArgs({
      prompt: opts.prompt,
      cwd: opts.cwd,
      permission: opts.permission,
      nativePermission: opts.nativePermission,
      model: opts.model,
      maxBudgetUsd: opts.maxBudgetUsd,
      addDirs: opts.addDirs,
      resumeSessionId: opts.resumeSessionId,
    });

    const proc = spawn(opts.harness.binary, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });

    const state: ParseState = { streamedText: '', activities: [], result: null, _harness: {} };
    let stderr = '';
    let settled = false;
    let firstTokenAt: number | null = null;
    // Resumed sessions replay every prior turn as session/update notifications before the new
    // prompt's — set once session/prompt is actually sent, so replayed text/activities (and a
    // replay-skewed TTFT) never reach the caller. See the handshake IIFE below.
    let promptSent = false;
    const startAt = Date.now();
    const MAX_STREAMED = 5 * 1024 * 1024; // 5MB cap to prevent OOM on compromised harness
    const MAX_ACTIVITIES = 5000;

    let nextId = 1;
    const pending = new Map<number, PendingRequest>();

    const finish = (r: StreamedResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectAllPending(new Error('session ended'));
      const ttft = firstTokenAt !== null ? firstTokenAt - startAt : r.ttftMs;
      resolve({ ...r, ttftMs: ttft, streamedText: state.streamedText, harness: opts.harness.name });
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectAllPending(err);
      reject(err);
    };
    function rejectAllPending(err: Error): void {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      pending.clear();
    }

    const writeLine = (msg: Record<string, unknown>): void => {
      try {
        proc.stdin.write(`${JSON.stringify(msg)}\n`);
      } catch {
        // stdin already closed (process exiting) — the pending request(s) time out/reject normally.
      }
    };

    /** Send a JSON-RPC request and await its response. `timeoutMs` bounds only this request —
     *  distinct from the overall run timeout — so a hung handshake step fails fast and clearly.
     *  Omitted for `session/prompt`: that's the actual work, already bounded by the overall
     *  `timer` below, which kills the process and rejects every pending request on fire. */
    const sendRequest = (method: string, params: unknown, timeoutMs?: number): Promise<unknown> => {
      const id = nextId++;
      return new Promise((res, rej) => {
        const entry: PendingRequest = { resolve: res, reject: rej };
        if (timeoutMs !== undefined) {
          entry.timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }
        pending.set(id, entry);
        writeLine({ jsonrpc: '2.0', id, method, params });
      });
    };

    /** Respond to a request the agent sent to us. Every request needs a reply or the agent's
     *  session hangs waiting for it. */
    const respond = (id: unknown, result: unknown): void => writeLine({ jsonrpc: '2.0', id, result });
    const respondError = (id: unknown, message: string): void =>
      writeLine({ jsonrpc: '2.0', id, error: { code: -32601, message } });

    /** Handle a request FROM the agent (has both `method` and `id`). We run non-interactively
     *  with a permission mode already negotiated, so the safe default is to decline anything
     *  not already covered by that mode rather than auto-approve — never observed in the captured
     *  fixture this harness was built from, but handled defensively since the spec allows it. */
    const handleServerRequest = (msg: Record<string, unknown>): void => {
      const { id, method, params } = msg;
      if (method === 'session/request_permission' && isRecord(params) && Array.isArray(params.options)) {
        const options = params.options as Array<{ optionId?: unknown; kind?: unknown }>;
        const reject =
          options.find(o => o.kind === 'reject_once') ??
          options.find(o => o.kind === 'reject_always') ??
          options.find(o => typeof o.kind === 'string' && o.kind.startsWith('reject'));
        if (reject && typeof reject.optionId === 'string') {
          respond(id, { outcome: { outcome: 'selected', optionId: reject.optionId } });
        } else {
          respond(id, { outcome: { outcome: 'cancelled' } });
        }
        return;
      }
      // fs/read_text_file, fs/write_text_file, terminal/* etc. — we declare no client capabilities
      // for these in `initialize`, so a well-behaved agent shouldn't ask; decline defensively if one does.
      respondError(id, `${String(method)} not supported by this client`);
    };

    const rl = createInterface({ input: proc.stdout });
    rl.on('line', line => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(msg)) return;

      if (typeof msg.method === 'string' && msg.id !== undefined) {
        handleServerRequest(msg);
        return;
      }
      if (msg.id !== undefined && 'result' in msg) {
        const entry = pending.get(msg.id as number);
        if (entry) {
          pending.delete(msg.id as number);
          clearTimeout(entry.timer);
          entry.resolve(msg.result);
        }
        // still fall through: `harness.parseLine` may also want to extract activity/result data.
      } else if (msg.id !== undefined && 'error' in msg) {
        const entry = pending.get(msg.id as number);
        if (entry) {
          pending.delete(msg.id as number);
          clearTimeout(entry.timer);
          const err = isRecord(msg.error) ? msg.error : {};
          entry.reject(new Error(typeof err.message === 'string' ? err.message : `${msg.id} failed`));
        }
        return;
      }

      const outcome = opts.harness.parseLine(line, state);
      // Discard streamed text/activities from anything that arrives before the new session/prompt
      // is sent — on a resume that's the replayed prior conversation, not the new turn's own output.
      if (promptSent && outcome.streamedText) {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        if (state.streamedText.length < MAX_STREAMED) {
          const remaining = MAX_STREAMED - state.streamedText.length;
          const chunk =
            outcome.streamedText.length > remaining
              ? `${outcome.streamedText.slice(0, remaining)} [truncated ${outcome.streamedText.length - remaining} chars]`
              : outcome.streamedText;
          state.streamedText += chunk;
          opts.onStream?.(chunk);
        }
      }
      if (promptSent && outcome.activities) {
        for (const a of outcome.activities) {
          if (state.activities.length < MAX_ACTIVITIES) {
            state.activities.push(a);
            opts.onActivity?.(a);
          }
        }
      }
      if (outcome.result) {
        if (!outcome.result.result) outcome.result.result = state.streamedText;
        state.result = outcome.result;
      }
    });

    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('close', code => {
      rejectAllPending(new Error(`${opts.harness.binary} exited`));
      if (code !== 0 && !state.result) {
        fail(new Error(stderr.trim() || `${opts.harness.binary} exited with code ${code}`));
        return;
      }
      const final = state.result ?? opts.harness.extractResult(state);
      if (final) {
        if (!final.result) final.result = state.streamedText;
        finish(final);
      } else if (code !== 0) {
        fail(new Error(stderr.trim() || `${opts.harness.binary} exited with code ${code}`));
      } else {
        fail(new Error(`${opts.harness.binary} finished without emitting a result`));
      }
    });
    proc.on('error', err => {
      fail(new Error(`failed to start ${opts.harness.binary}: ${err.message}`));
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      fail(new Error(`${opts.harness.binary} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();

    opts.signal?.addEventListener(
      'abort',
      () => {
        proc.kill('SIGKILL');
        fail(new Error('cancelled'));
      },
      { once: true },
    );

    // Drive the handshake. `session/prompt` has no separate timeout — it's the actual work,
    // bounded by the overall `timer` above like everything else.
    (async () => {
      const modeId = opts.nativePermission ?? opts.harness.permissionMap?.[opts.permission]?.[0] ?? opts.permission;
      const initResult = await sendRequest(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}, // no fs/terminal proxying — decline those requests if asked (see handleServerRequest)
        },
        HANDSHAKE_TIMEOUT_MS,
      );
      if (settled) return;
      // The client "should disconnect" (spec text) if the agent didn't echo back the version we
      // asked for — only `1` has ever shipped, so this is cheap insurance against a future
      // version-mismatched agent producing a confusing mid-handshake failure instead of a clear one.
      const negotiatedVersion = isRecord(initResult) ? initResult.protocolVersion : undefined;
      if (negotiatedVersion !== PROTOCOL_VERSION) {
        throw new Error(
          `${opts.harness.binary} negotiated ACP protocolVersion ${JSON.stringify(negotiatedVersion)}, expected ${PROTOCOL_VERSION}`,
        );
      }
      const sessionParams = {
        cwd: opts.cwd,
        mcpServers: [],
        ...(opts.addDirs && opts.addDirs.length > 0 ? { additionalDirectories: opts.addDirs } : {}),
      };
      // `session/load` resumes a prior session by id (its response carries no sessionId of its
      // own — the client already has it) and replays prior turns as session/update notifications
      // before the new prompt's; `session/new` mints a fresh one. Verified live: loadSession is
      // advertised in agentCapabilities and a real session/load + follow-up prompt round-trips
      // cleanly, replaying history and continuing the same token-usage accounting.
      let sessionId: string | null;
      let sessionResult: unknown;
      if (opts.resumeSessionId) {
        sessionResult = await sendRequest(
          'session/load',
          { sessionId: opts.resumeSessionId, ...sessionParams },
          HANDSHAKE_TIMEOUT_MS,
        );
        sessionId = opts.resumeSessionId;
      } else {
        sessionResult = await sendRequest('session/new', sessionParams, HANDSHAKE_TIMEOUT_MS);
        sessionId =
          isRecord(sessionResult) && typeof sessionResult.sessionId === 'string' ? sessionResult.sessionId : null;
      }
      if (settled) return;
      if (!sessionId) throw new Error('session/new did not return a sessionId');
      // session/load's response carries no sessionId of its own (unlike session/new's) — stash it
      // so the harness's parseLine can still report the real session id on the final result.
      if (opts.resumeSessionId) {
        state._harness ??= {};
        state._harness.sessionId = sessionId;
      }
      // `session/set_mode` (and `NewSessionResponse.modes`) are spec-optional — calling it
      // unconditionally against a mode-less agent would fail the whole handshake with a raw
      // "method not found" instead of a clear message. Every agent this project has captured
      // (Devin, opencode, omp) does support it, so this never fires for a real run today — but per
      // the brief, a mode we can't confirm is a hard error, not a silent downgrade to whatever the
      // agent's default permissiveness happens to be: we already promised the caller a specific
      // permission tier.
      if (!supportsSessionModes(sessionResult)) {
        throw new Error(
          `${opts.harness.binary} does not advertise session-mode support (no "modes" field or ` +
            `configOptions "mode" category on session/${opts.resumeSessionId ? 'load' : 'new'}) — ` +
            `cannot verify the "${opts.permission}" permission tier would be honored over ACP`,
        );
      }
      await sendRequest('session/set_mode', { sessionId, modeId }, HANDSHAKE_TIMEOUT_MS);
      if (settled) return;
      promptSent = true;
      await sendRequest('session/prompt', { sessionId, prompt: [{ type: 'text', text: opts.prompt }] });
      if (settled) return;
      // The agent doesn't exit on its own once the turn is done — an ACP session can outlive a
      // single prompt (resume, follow-up turns). `delegate()` is one-shot per process, so finish
      // as soon as the prompt response resolves (parseLine already turned it into state.result,
      // synchronously, before this await's continuation runs) and tear the process down ourselves.
      const final = state.result ?? opts.harness.extractResult(state);
      if (final) {
        if (!final.result) final.result = state.streamedText;
        finish(final);
      } else {
        fail(new Error(`${opts.harness.binary} session/prompt completed without emitting a result`));
      }
      proc.kill('SIGKILL');
    })().catch(err => {
      // Every other exit path (timeout, abort, success) kills the child — a rejected handshake
      // step (bad modeId, a JSON-RPC error, a HANDSHAKE_TIMEOUT_MS expiry) must too, or the
      // process leaks: ACP agents only exit on stdin EOF, which nothing else here sends.
      proc.kill('SIGKILL');
      fail(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
