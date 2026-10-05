import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withEnv } from './env.ts';
import { withViewport } from './viewport.ts';

/**
 * Shared scaffolding for tests that drive the real extension (`delegate()`, the registered tools and
 * commands) without a real harness binary: a throwaway agent dir + project, fake `pi`/`ctx`, and fake
 * harness executables on PATH. Mirrors the helpers in delegate-engine.test.ts.
 */

export interface Sandbox {
  agentDir: string;
  cwd: string;
}

/**
 * A temp agent dir (`PI_CODING_AGENT_DIR`) with `settings.json` and a project dir. `templates` maps
 * `<harness>/<name>` (or a bare `<name>` for the shared project root) to file contents, all written
 * under the project's `.pi/delegate/templates/`.
 */
export async function withSandbox<T>(
  opts: {
    templates?: Record<string, string>;
    userTemplates?: Record<string, string>;
    settings?: Record<string, unknown>;
  },
  fn: (s: Sandbox) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'delegate-sandbox-'));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'project');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({ delegate: { maxConcurrent: 4, maxTranscripts: 5, ...opts.settings } }),
  );
  const write = (base: string, files: Record<string, string> | undefined) => {
    for (const [key, body] of Object.entries(files ?? {})) {
      const file = join(base, `${key}.md`);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, body);
    }
  };
  write(join(cwd, '.pi', 'delegate', 'templates'), opts.templates);
  write(join(agentDir, 'delegate', 'templates'), opts.userTemplates);
  try {
    // every confirmation dialog is laid out for the terminal's size: pin it, so a test never depends on the developer's window
    return await withViewport(80, 40, () => withEnv({ PI_CODING_AGENT_DIR: agentDir }, () => fn({ agentDir, cwd })));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A template file body. `extra` is raw frontmatter lines (newline-separated). */
export function tpl(name: string, permission: string, extra = '', body = 'Do it.'): string {
  return `---\nname: ${name}\ndescription: test ${name}\npermission: ${permission}\n${extra ? `${extra}\n` : ''}---\n${body}\n`;
}

export function fakeCtx(cwd: string, trusted = true): never {
  return { cwd, hasUI: false, isProjectTrusted: () => trusted } as never;
}

export function fakePi(exec: (cmd: string, args: string[]) => Promise<unknown>): never {
  return { exec } as never;
}

export interface CapturedTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
}

/** Load the extension's default export against a recording fake `pi`. */
export async function loadExtension(exec: (cmd: string, args: string[]) => Promise<unknown> = async () => ({})) {
  const mod = await import('../../extensions/index.ts');
  const tools = new Map<string, CapturedTool>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    exec,
    registerTool: (t: CapturedTool) => tools.set(t.name, t),
    registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, c),
    on: () => {},
  };
  mod.default(pi as never);
  return { tools, commands };
}

/** An interactive ctx whose overlays mount (and close) immediately and whose confirm is scripted. */
export function uiCtx(cwd: string, answer: boolean, trusted = true) {
  const asked: string[] = [];
  const notes: string[] = [];
  const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
  const ctx = {
    cwd,
    hasUI: true,
    isProjectTrusted: () => trusted,
    ui: {
      theme,
      confirm: async (_title: string, message: string) => {
        asked.push(message);
        return answer;
      },
      notify: (msg: string) => notes.push(msg),
      setStatus: () => {},
      custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => unknown) =>
        new Promise(resolve => {
          const comp = factory({ requestRender() {} }, theme, {}, v => {
            (comp as { dispose?: () => void } | undefined)?.dispose?.();
            resolve(v);
          }) as { dispose?: () => void };
        }),
    },
  };
  return { ctx, asked, notes };
}

/**
 * Put fake `<name>` executables first on PATH for the duration of `fn`. Each records its argv (one
 * per line) to `$FAKE_ARGS_FILE` and `$FAKE_ARGS_FILE.<name>`, prints `stdoutLines`, then optionally
 * sleeps (`sleepAfterSec`) before exiting.
 */
export async function withFakeBinaries<T>(
  names: string[],
  stdoutLines: string[],
  fn: (argsFile: string) => Promise<T>,
  opts: { sleepAfterSec?: number } = {},
): Promise<T> {
  const binDir = mkdtempSync(join(tmpdir(), 'fake-bin-'));
  const argsFile = join(binDir, 'args.txt');
  const body = stdoutLines.map(l => `printf '%s\\n' '${l.replace(/'/g, `'\\''`)}'`).join('\n');
  const script = `#!/bin/sh\nprintf '%s\\n' "$@" > "$FAKE_ARGS_FILE"\nprintf '%s\\n' "$@" > "$FAKE_ARGS_FILE.$(basename "$0")"\n${body}\n${opts.sleepAfterSec ? `exec sleep ${opts.sleepAfterSec}\n` : ''}`;
  for (const name of names) {
    writeFileSync(join(binDir, name), script);
    chmodSync(join(binDir, name), 0o755);
  }
  try {
    return await withEnv({ PATH: `${binDir}:${process.env.PATH}`, FAKE_ARGS_FILE: argsFile }, () => fn(argsFile));
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

/** Restrict PATH to the fake binaries (`dirname(argsFile)`) plus the system dirs, so no real harness
 *  is detected — for fan-out tests whose resolved harness list must not depend on the machine. */
export async function withOnlyFakes<T>(argsFile: string, fn: () => Promise<T>): Promise<T> {
  return withEnv({ PATH: `${dirname(argsFile)}:/usr/bin:/bin` }, fn);
}

export function readArgs(file: string): string[] | null {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : null;
}

export const CLAUDE_RESULT = JSON.stringify({
  type: 'result',
  result: 'all good',
  total_cost_usd: 0.01,
  num_turns: 1,
  session_id: 'sess-1',
});

export const CODEX_RESULT_LINES = [
  JSON.stringify({ type: 'thread.started', thread_id: 'thr-1' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'all good' } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }),
];
