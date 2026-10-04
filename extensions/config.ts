import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_TIMEOUT_MS, type Harness, type Transport } from './harnesses/types.ts';

export interface HarnessConfig {
  model?: string;
  timeoutMs?: number;
  allowDangerous?: boolean;
  maxBudgetUsd?: number;
  /** Overrides the harness's default transport ('stdout' unless the harness itself defaults to
   *  'acp', e.g. Devin). A malformed value (not 'stdout'/'acp') is dropped at load time, same as
   *  every other per-harness field's defensive parsing below; a well-formed but unsupported value
   *  (e.g. 'acp' for a harness with no ACP surface) is *not* dropped here — it's validated against
   *  `Harness.supportsTransports` by `resolveTransport()` instead, so misconfiguring it fails the
   *  run with a clear message rather than being silently ignored. */
  transport?: Transport;
}

export interface DelegateConfig {
  model?: string;
  timeoutMs: number;
  defaultMode: string;
  defaultHarness: string;
  allowDangerous: boolean;
  inspectThinking: boolean;
  maxBudgetUsd?: number;
  autoDelegateHints: boolean;
  modelAliases: Record<string, string>;
  maxConcurrent: number | { global?: number; perHarness?: Record<string, number> };
  maxTranscripts: number;
  harnesses: Record<string, HarnessConfig>;
}

/**
 * Provenance for how `loadConfig()` actually resolved its settings — the bit a bare `try/catch {}`
 * used to erase entirely, making "no file", "file, no relevant key", and "file, unparseable" all
 * look identical (empty defaults, no signal anywhere). `usedKey` is which key ended up populating
 * `cfg`: `'delegate'` and `'claudeDelegate'` are mutually exclusive (the legacy branch only runs
 * when `delegate` is *absent*), so `'claudeDelegate'` here means the legacy-only case that costs
 * the user every setting under `delegate` — not "legacy key present at all" (see
 * `legacyKeyPresent` for that). `raw` is the literal value of whichever key was used, exactly as
 * read from the file — no defaults merged in, no per-field sanitizing — so `/delegate config` can
 * show what was actually written next to what it resolved to.
 */
export interface ConfigSource {
  file: string;
  fileExists: boolean;
  /** Set when the file exists but `JSON.parse` failed, or the parsed value isn't a JSON object
   *  (e.g. an array or a bare string) — either way `cfg` fell back to defaults. */
  parseError?: string;
  usedKey: 'delegate' | 'claudeDelegate' | 'none';
  /** Whether a `claudeDelegate` key exists in the file at all, independent of `usedKey` — true
   *  even when `delegate` won and `claudeDelegate` was only partially merged (the `model`
   *  fallback below). */
  legacyKeyPresent: boolean;
  raw?: unknown;
}

export interface ConfigLoadResult {
  config: DelegateConfig;
  source: ConfigSource;
}

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
}

export function outputsDir(harness?: string): string {
  const base = join(agentDir(), 'delegate', 'outputs');
  return harness ? join(base, harness) : base;
}

export function legacyOutputsDir(): string {
  return join(agentDir(), 'claude-delegate', 'outputs');
}

/** Drops a malformed `transport` (anything but 'stdout'/'acp', including absent) before it's
 *  stored — the rest of `HarnessConfig`'s fields are spread through as-is by `loadConfig()`. */
function sanitizeHarnessConfig(v: HarnessConfig): HarnessConfig {
  const out = { ...v };
  if (out.transport !== 'stdout' && out.transport !== 'acp') delete out.transport;
  return out;
}

/** Built-in defaults — a fresh object each call, since callers mutate the result. */
export function defaultDelegateConfig(): DelegateConfig {
  return {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    defaultMode: 'general',
    defaultHarness: 'claude',
    allowDangerous: false,
    inspectThinking: false,
    autoDelegateHints: false,
    modelAliases: { economy: 'haiku', balanced: 'sonnet', max: 'opus' },
    maxConcurrent: 4,
    maxTranscripts: 100,
    harnesses: {},
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** `maxConcurrent.perHarness` from raw settings: only non-negative numeric entries survive.
 *  Undefined when the value isn't an object or no entry is valid. */
export function parsePerHarness(raw: unknown): Record<string, number> | undefined {
  if (!isObject(raw)) return undefined;
  const ph: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number' && v >= 0) ph[k] = v;
  }
  return Object.keys(ph).length > 0 ? ph : undefined;
}

/** `maxConcurrent` from raw settings (shared by the `delegate` and legacy `claudeDelegate` keys):
 *  a non-negative number, or `{global?, perHarness?}` with at least one valid part. Undefined
 *  means "not configured / invalid — keep the default". */
export function parseMaxConcurrent(raw: unknown): DelegateConfig['maxConcurrent'] | undefined {
  if (typeof raw === 'number') return raw >= 0 ? raw : undefined;
  if (!isObject(raw)) return undefined;
  const out: { global?: number; perHarness?: Record<string, number> } = {};
  if (typeof raw.global === 'number' && raw.global >= 0) out.global = raw.global;
  const perHarness = parsePerHarness(raw.perHarness);
  if (perHarness) out.perHarness = perHarness;
  return out.global !== undefined || out.perHarness ? out : undefined;
}

/**
 * Only the top-level settings whose effective value differs from the built-in default.
 *
 * What `/delegate config init` writes. Writing the full effective config would pin every default
 * into settings.json, and the loader treats a present value as user intent — so a later release
 * that changes a default (maxConcurrent 1 -> 4 already did) would never reach that user.
 */
export function nonDefaultConfig(cfg: DelegateConfig): Partial<DelegateConfig> {
  const defaults = defaultDelegateConfig();
  const out: Partial<DelegateConfig> = {};
  // Typed per key so each value is copied into `out` under its own field type — no casts.
  const keep = <K extends keyof DelegateConfig>(k: K): void => {
    const v = cfg[k];
    if (v !== undefined && JSON.stringify(v) !== JSON.stringify(defaults[k])) out[k] = v;
  };
  for (const k of Object.keys(cfg) as (keyof DelegateConfig)[]) {
    if (k === 'modelAliases') {
      // The loader merges aliases additively onto the defaults, so only the keys that differ need
      // writing — whole-object diffing would pin the untouched default aliases next to a custom one.
      const d = defaults.modelAliases;
      const diff = Object.fromEntries(Object.entries(cfg.modelAliases ?? {}).filter(([a, t]) => d[a] !== t));
      if (Object.keys(diff).length > 0) out.modelAliases = diff;
      continue;
    }
    keep(k);
  }
  return out;
}

/**
 * Loads `delegate` config from `~/.pi/agent/settings.json` alongside `ConfigSource`, describing
 * how that happened (file present? which key won? did it fail to parse?) — see `ConfigSource`'s
 * doc comment. `loadConfig()` below is a thin wrapper for the existing call sites that only want
 * the resolved values; this is the one place that actually reads/parses the file, so a caller
 * needing both never pays for a second parse. Never throws — any failure (missing file, bad JSON,
 * a non-object root) is recorded on `source` and falls back to the same defaults `loadConfig()`
 * has always returned.
 */
export function loadConfigWithSource(): ConfigLoadResult {
  const cfg = defaultDelegateConfig();
  const file = join(agentDir(), 'settings.json');
  const source: ConfigSource = { file, fileExists: false, usedKey: 'none', legacyKeyPresent: false };
  try {
    if (!existsSync(file)) return { config: cfg, source };
    source.fileExists = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      source.parseError = err instanceof Error ? err.message : String(err);
      return { config: cfg, source };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      source.parseError = 'settings.json root is not a JSON object';
      return { config: cfg, source };
    }
    const settings = parsed as {
      delegate?: Partial<DelegateConfig & { harnesses: Record<string, HarnessConfig> }>;
      claudeDelegate?: Partial<DelegateConfig & { model?: string }>;
    };
    source.legacyKeyPresent = Boolean(settings.claudeDelegate);
    // Legacy claudeDelegate -> delegate.harnesses.claude migration
    if (settings.claudeDelegate && !settings.delegate) {
      source.usedKey = 'claudeDelegate';
      source.raw = settings.claudeDelegate;
      const c = settings.claudeDelegate as Partial<DelegateConfig>;
      if (typeof c.model === 'string') cfg.harnesses.claude = { ...(cfg.harnesses.claude ?? {}), model: c.model };
      if (typeof c.timeoutMs === 'number' && c.timeoutMs > 0) cfg.timeoutMs = c.timeoutMs;
      if (typeof c.defaultMode === 'string') cfg.defaultMode = c.defaultMode;
      if (typeof c.allowDangerous === 'boolean') cfg.allowDangerous = c.allowDangerous;
      if (typeof c.inspectThinking === 'boolean') cfg.inspectThinking = c.inspectThinking;
      const maxBudgetLegacy = (c as DelegateConfig).maxBudgetUsd;
      if (typeof maxBudgetLegacy === 'number' && maxBudgetLegacy > 0) cfg.maxBudgetUsd = maxBudgetLegacy;
      if (typeof c.autoDelegateHints === 'boolean') cfg.autoDelegateHints = c.autoDelegateHints;
      const legacyAliases = (c as DelegateConfig).modelAliases;
      if (legacyAliases && typeof legacyAliases === 'object') {
        for (const [k, v] of Object.entries(legacyAliases)) {
          if (typeof v === 'string' && v) cfg.modelAliases[k] = v;
        }
      }
      const legacyMaxConcurrent = parseMaxConcurrent(c.maxConcurrent);
      if (legacyMaxConcurrent !== undefined) cfg.maxConcurrent = legacyMaxConcurrent;
      if (typeof c.maxTranscripts === 'number' && c.maxTranscripts >= 0) cfg.maxTranscripts = c.maxTranscripts;
      if (c.harnesses && typeof c.harnesses === 'object') {
        for (const [k, v] of Object.entries(c.harnesses)) {
          if (v && typeof v === 'object')
            cfg.harnesses[k] = { ...(cfg.harnesses[k] ?? {}), ...sanitizeHarnessConfig(v as HarnessConfig) };
        }
      }
      // also map harnesses.claude if any
      return { config: cfg, source };
    }
    source.usedKey = settings.delegate ? 'delegate' : 'none';
    source.raw = settings.delegate;
    const d = settings.delegate ?? {};
    if (typeof d.defaultHarness === 'string' && d.defaultHarness) cfg.defaultHarness = d.defaultHarness;
    if (typeof d.defaultMode === 'string') cfg.defaultMode = d.defaultMode;
    if (typeof d.model === 'string') cfg.model = d.model;
    if (typeof d.timeoutMs === 'number' && d.timeoutMs > 0) cfg.timeoutMs = d.timeoutMs;
    if (typeof d.allowDangerous === 'boolean') cfg.allowDangerous = d.allowDangerous;
    if (typeof d.inspectThinking === 'boolean') cfg.inspectThinking = d.inspectThinking;
    if (typeof d.maxBudgetUsd === 'number' && d.maxBudgetUsd > 0) cfg.maxBudgetUsd = d.maxBudgetUsd;
    if (typeof d.autoDelegateHints === 'boolean') cfg.autoDelegateHints = d.autoDelegateHints;
    if (d.modelAliases && typeof d.modelAliases === 'object') {
      for (const [k, v] of Object.entries(d.modelAliases)) {
        if (typeof v === 'string' && v) cfg.modelAliases[k] = v;
      }
    }
    const maxConcurrent = parseMaxConcurrent(d.maxConcurrent);
    if (maxConcurrent !== undefined) cfg.maxConcurrent = maxConcurrent;
    if (typeof d.maxTranscripts === 'number' && d.maxTranscripts >= 0) cfg.maxTranscripts = d.maxTranscripts;
    if (d.harnesses && typeof d.harnesses === 'object') {
      for (const [k, v] of Object.entries(d.harnesses)) {
        if (v && typeof v === 'object') cfg.harnesses[k] = sanitizeHarnessConfig(v as HarnessConfig);
      }
    }
    // also support legacy claudeDelegate merged when delegate also present (delegate wins)
    if (settings.claudeDelegate) {
      const c = settings.claudeDelegate as Partial<DelegateConfig>;
      if (typeof c.model === 'string' && !cfg.harnesses.claude?.model) {
        cfg.harnesses.claude = { ...(cfg.harnesses.claude ?? {}), model: c.model };
      }
    }
  } catch (err) {
    // Anything unexpected (e.g. a read error after existsSync's check raced a delete) — still
    // never throw; record it as a parse error so it's not silently indistinguishable from "no
    // config" if it wasn't already caught (and thus reported) above.
    if (!source.parseError) source.parseError = err instanceof Error ? err.message : String(err);
  }
  return { config: cfg, source };
}

export function loadConfig(): DelegateConfig {
  return loadConfigWithSource().config;
}

/**
 * Human-readable lines describing how `loadConfig()` actually resolved its settings — the
 * provenance report used by both `/delegate status` and `/delegate config`. Pure: takes the
 * `ConfigSource` companion to `loadConfigWithSource()`'s result, no I/O, so it's testable without
 * touching the filesystem.
 */
export function describeConfigSource(source: ConfigSource): string[] {
  if (source.parseError) {
    return [
      `⚠ ${source.file} exists but failed to parse: ${source.parseError}`,
      '  using defaults until this is fixed',
    ];
  }
  if (!source.fileExists) {
    return [`${source.file} not found — using defaults`];
  }
  if (source.usedKey === 'none') {
    return [`${source.file} has no "delegate" key — using defaults`];
  }
  if (source.usedKey === 'claudeDelegate') {
    return [
      `⚠ using legacy "claudeDelegate" key in ${source.file}`,
      '  two settings can never be reached this way: "defaultHarness" stays pinned to "claude", and there\'s no',
      '  top-level default "model" (only claudeDelegate.model -> harnesses.claude.model migrates) — everything',
      '  else (including per-harness settings like harnesses.<name>.transport) migrates fine',
      '  rename "claudeDelegate" to "delegate" to unlock those two, or run `/delegate config init` to write an',
      '  explicit "delegate" key for you (claudeDelegate itself is left untouched either way)',
    ];
  }
  const lines = [`"delegate" key in ${source.file}`];
  if (source.legacyKeyPresent) {
    lines.push('  legacy "claudeDelegate" key is also present — ignored except claudeDelegate.model as a fallback');
  }
  return lines;
}

/**
 * Full `/delegate config` report: provenance (`describeConfigSource`), the raw `delegate`/
 * `claudeDelegate` value exactly as written in the file, and the effective config with defaults
 * merged in — so a user can see both what they wrote and what it resolved to, and has a
 * paste-ready starting point either way. Pure — takes an already-loaded `ConfigLoadResult`.
 */
export function buildConfigReport(result: ConfigLoadResult): string[] {
  const lines = [...describeConfigSource(result.source)];
  lines.push('');
  lines.push('from file (as written, before defaults are applied):');
  lines.push(JSON.stringify(result.source.raw ?? {}, null, 2));
  lines.push('');
  lines.push('effective config (file merged with defaults) — for reference; you only need to put the values');
  lines.push('you want to change under "delegate" (`/delegate config init` writes just those, not defaults):');
  lines.push(JSON.stringify({ delegate: result.config }, null, 2));
  return lines;
}

export interface WriteConfigResult {
  ok: boolean;
  file: string;
  message: string;
}

/**
 * Writes `delegateSubtree` into `settings.json` under the `delegate` key — replacing only that
 * key and preserving every other top-level key verbatim (including a leftover `claudeDelegate`,
 * which is never touched or removed here; that's the user's call, made by editing the file
 * themselves). Read-modify-write, atomic: writes to `<file>.<pid>.tmp` in the same directory then
 * `renameSync`s over the target, so a process death mid-write can never leave a torn file. Refuses
 * to write (returns `ok: false`, file untouched) when the existing file is present but fails to
 * parse or isn't a JSON object — overwriting an already-broken file would destroy whatever the
 * user has in it; the caller should fall back to `buildConfigReport`'s paste-ready block instead.
 * Never throws. Only ever called from an explicit user action (`/delegate config init`) — never
 * on the strength of a read like `loadConfig()`/`showStatus`.
 */
export function writeDelegateConfig(delegateSubtree: unknown): WriteConfigResult {
  const configured = join(agentDir(), 'settings.json');
  // Write through a symlink to its real target rather than replacing the link with a regular file.
  let file = configured;
  try {
    file = realpathSync(configured);
  } catch {
    // absent — created below
  }
  // pi locks the path as configured (proper-lockfile realpath:false), not a symlink's target.
  const lock = `${configured}.lock`;
  const tmp = join(dirname(file), `settings.json.${process.pid}.tmp`);
  let locked = false;
  try {
    let root: Record<string, unknown> = {};
    let mode: number | undefined;
    let trailingNewline = false;
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return {
          ok: false,
          file,
          message: `refusing to write: ${file} exists but failed to parse (${err instanceof Error ? err.message : String(err)}) — fix or remove it first`,
        };
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, file, message: `refusing to write: ${file} exists but its root isn't a JSON object` };
      }
      root = parsed as Record<string, unknown>;
      mode = statSync(file).mode & 0o777;
      trailingNewline = raw.endsWith('\n');
    }
    mkdirSync(dirname(file), { recursive: true });
    // pi saves settings.json under proper-lockfile (`<file>.lock`, a directory taken with an atomic
    // mkdir). Take the same lock, without waiting, so we neither lose a concurrent pi write nor have
    // ours overwritten mid-read-modify-write. The read above is repeated under the lock.
    try {
      mkdirSync(lock);
      locked = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return {
          ok: false,
          file,
          message: `refusing to write: ${file} is locked (another pi session is saving settings, or a crashed one left a stale lock that pi clears after ~10s) — retry in a moment`,
        };
      }
      throw err;
    }
    if (existsSync(file)) {
      const again: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (again === null || typeof again !== 'object' || Array.isArray(again)) {
        return { ok: false, file, message: `refusing to write: ${file} changed and its root isn't a JSON object` };
      }
      root = again as Record<string, unknown>;
    }
    root.delegate = delegateSubtree;
    // Match the file's own format: pi writes JSON.stringify(x, null, 2) with no trailing newline.
    writeFileSync(tmp, `${JSON.stringify(root, null, 2)}${trailingNewline ? '\n' : ''}`, { encoding: 'utf8' });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, file);
    return { ok: true, file, message: `wrote "delegate" key to ${file}` };
  } catch (err) {
    return { ok: false, file, message: `failed to write ${file}: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    // Cleanup is best-effort: this function must never throw.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // nothing useful to do
    }
    // Separate from the tmp cleanup so a failure there can never leave pi's lock behind.
    if (locked) {
      try {
        rmSync(lock, { recursive: true, force: true });
      } catch {
        // nothing useful to do
      }
    }
  }
}

export function resolveModelForHarness(
  cfg: DelegateConfig,
  harness: string,
  model?: string,
  templateModel?: string,
): string | undefined {
  const resolve = (m?: string) => (m ? (cfg.modelAliases[m] ?? m) : undefined);
  return resolve(model) ?? resolve(templateModel) ?? resolve(cfg.harnesses[harness]?.model) ?? resolve(cfg.model);
}

/**
 * Which transport a run should actually use: config override, falling back to the harness's own
 * default (`harness.transport`, e.g. Devin's static 'acp'), falling back to 'stdout'. Validated
 * against `harness.supportsTransports` — the ceiling of what the binary can actually do, distinct
 * from what's configured — *before* the caller acquires a run slot or spawns anything, so
 * misconfiguring e.g. `transport: 'acp'` for `claude` fails fast with a clear message instead of a
 * cryptic "unknown subcommand" from the spawned process. See docs/acp-harness-assessment.md §5/§6.
 */
export function resolveTransport(cfg: DelegateConfig, harnessName: string, harness: Harness): Transport {
  const transport = cfg.harnesses[harnessName]?.transport ?? harness.transport ?? 'stdout';
  const allowed = harness.supportsTransports ?? [harness.transport ?? 'stdout'];
  if (!allowed.includes(transport)) {
    throw new Error(
      `delegate.harnesses.${harnessName}.transport is "${transport}", but ${harnessName} only supports: ${allowed.join(', ')}`,
    );
  }
  return transport;
}

export function getMaxConcurrent(cfg: DelegateConfig, harness?: string): number {
  if (typeof cfg.maxConcurrent === 'number') return cfg.maxConcurrent;
  // object shape {global, perHarness} — narrowed by the number check above
  const mc = cfg.maxConcurrent;
  const perHarness = harness ? mc.perHarness?.[harness] : undefined;
  if (typeof perHarness === 'number') return perHarness;
  if (typeof mc.global === 'number') return mc.global;
  return 1;
}
