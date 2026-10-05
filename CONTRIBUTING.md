# Contributing

Development and release notes for `pi-harness-delegate`.

## Prerequisites

- Node.js 22, 24, or 26 (the `engines` range; CI tests all three)
- Bun 1.3.14 (`curl -fsSL https://bun.sh/install | bash`)
- `npm` account (publishing goes through OIDC trusted publishing — no token needed for CI)
- [pi coding agent](https://github.com/badlogic/pi-mono) installed (load-testing)
- `claude`/`codex`/`opencode`/`amp` (or `omp`)/`devin` CLIs on PATH — only for the opt-in live suite below; every
  other test replays captured fixtures or spawns a fake `node -e` process

## Setup and checks

```bash
bun install
bun run lint        # Biome check (2 spaces, 120 cols, single quotes)
bun run lint:fix    # auto-fix
bun run typecheck   # tsc --noEmit (extensions/, tests/, scripts/)
bun test            # bun:test (node:test compatible)
bun run test:coverage  # tests + per-file line/function coverage (text table + coverage/lcov.info)
bun run verify      # lint + typecheck + test (also runs in CI/release)
```

Coverage is informational only — no thresholds, and it is not part of `verify` or CI. `coverage/` is git-ignored.

CI runs `lint` + `typecheck` + `test` as separate steps (the same set `verify` bundles) + `check-packables` + changeset presence on every push/PR (`.github/workflows/ci.yml`).

### Live integration suite (opt-in)

`tests/live.test.ts` spawns each *installed* harness for real with a tiny read-only prompt in a scratch repo —
the only test that catches a `buildArgs` the real CLI rejects. It never runs in CI or `bun run verify`; it
costs real time and, for most harnesses, real API spend:

```bash
PI_DELEGATE_LIVE=1 bun test tests/live.test.ts --timeout 90000
```

Harnesses whose binary isn't on `PATH` are skipped. An account-side failure (exhausted quota, missing auth)
is reported as a real failure, on purpose.

Name `tests/live.test.ts` explicitly, as above. An unfiltered `PI_DELEGATE_LIVE=1 bun test` is still safe — every
other file stays on the pinned agent dir (see below) — but it runs the whole suite and pays for the live runs too.

### Isolating state: `PI_CODING_AGENT_DIR`

Everything this extension reads or writes under `~/.pi/agent` — `settings.json`, user templates
(`delegate/templates/`), transcripts (`delegate/outputs/`), and the active-run registry (`delegate/runs/`) —
resolves from `PI_CODING_AGENT_DIR` when it's set. Tests point it at a temp dir; you can do the same for a
throwaway manual session.

As a safety net, `bun test` preloads `tests/helpers/preload.ts` (wired in `bunfig.toml`), which pins
`PI_CODING_AGENT_DIR` to a fresh `mkdtemp` dir under `os.tmpdir()` for the whole test process — overriding any
outer value — and removes it at the end of the run (a `bun:test` `afterAll`, plus `'exit'`) and on
SIGINT/SIGTERM/SIGHUP (re-raised afterwards, so Ctrl-C still stops the run with the usual status; if some other
code also listens for that signal, the run isn't killed by it, so the dir is left for the end-of-run cleanup instead). A test that sets its own via `withEnv`/`withSandbox` is restored to that pinned
dir, never to unset, so a run that outlives its sandbox can't reach your real `~/.pi/agent`. `bunfig.toml` and
`tests/` are not in `package.json` `files`, so none of this ships.

- **Run `bun test` from the repo root (or from `tests/`).** bun reads `bunfig.toml` only from its current
  directory; the repo root's and `tests/bunfig.toml` both wire the preload. `bun run test` works from anywhere —
  package scripts run from the package root. From any *other* directory no preload runs, so nothing is pinned, and
  there is no way to notice from inside the run except `tests/preload.test.ts` (it checks a marker the preload sets
  and never imports the preload itself): a run that includes it fails loudly, but a run of only other files passes
  silently, unpinned. Don't do that.
- **Live mode is pinned too.** `PI_DELEGATE_LIVE=1` doesn't turn the pin off. The live suite hands the outer
  `PI_CODING_AGENT_DIR` (recorded by the preload, `preloadState().outerAgentDir`; absent when it was unset) to
  the real harness CLIs' child processes only — `omp` (the `amp` harness) reads that var as its own agent dir for
  auth/models. It swaps env with the synchronous `withEnvSync` around just the call that spawns the child
  (`spawn` snapshots `process.env` when called), so the test process itself is re-pinned before the run is even
  awaited. Don't hold an async `withEnv` across a long run: it restores only when the run settles, which can be
  after bun's per-test timeout has moved on, and overlapping restores can then leave the process unpinned.
- **Never import `tests/helpers/preload.ts` from a test.** Shared constants and helpers live in the side-effect-free
  `tests/helpers/preload-state.ts`.

### Setting env vars in tests

Use `withEnv({ NAME: value }, fn)` (or `restoreEnv(name, prev)`) from `tests/helpers/env.ts` — never
`process.env.X = prev`. When `X` was unset, `prev` is `undefined`, and Node and Bun both store that as the
*string* `"undefined"`. A restored `PI_CODING_AGENT_DIR="undefined"` once sent a straggling run's transcript
into a relative `undefined/delegate/outputs/...` directory inside the repo. The helper deletes a var that was
unset and restores it in `finally`, even when `fn` is async or throws (`tests/env.test.ts` covers it).

`tests/env-hygiene.test.ts` fails if any other source file under `tests/` (`.ts`/`.js`/`.mjs`/`.tsx`/…,
`fixtures/` included) touches `process.env`/`Bun.env`/`import.meta.env` in anything but a plain read. It is an
allowlist, not a list of banned write shapes: `env.X`/`env[k]` used as a value, and the env object itself only in
`'X' in process.env`, `{ ...process.env }`, `{ env: process.env }` (a spawn option), `Object.keys/values/entries/hasOwn(process.env)`,
`const { A } = process.env` or `typeof`. Everything else fails — assignments of every kind, `delete`, `++`, passing
`process.env` to a function, destructuring/parenthesised targets (`[process.env.X] = …`, `(process.env).X = …`).
Using `process`/`Bun` as a bare value (`const p = process`, `const { env } = process`), `= globalThis`, and importing
from `process`/`node:process` (or `env`/`*` from `bun`) are banned outright. It scans whole files with comments and
string/regex text stripped, so mentioning the pattern in a comment or message is fine. To hand a child process a
modified env, build a copy (`{ ...process.env, X: '1' }`) instead. If it flags a harmless shape (e.g.
`obj[process.env.K] = v`, or a default value inside a destructuring pattern), read the var into a local first.

As a runtime backstop, the preload's `afterEach` fails any test that leaves an env var whose value is exactly
`"undefined"` or `"null"` — or not a string at all, which is what bun 1.3.14 stores (see below) — and removes it so
later tests aren't affected. It catches what a static scan can't, but
it's not a proof: a test that coerces and cleans up within its own body slips past it.

### Tests that spawn processes

Wait on conditions, not clocks: `tests/helpers/wait.ts` (`waitFor`, `readPid`, `waitForProcessExit`,
`waitForNoProcessWithArg`). Give a spawning test an explicit generous timeout (`test(name, { timeout: 60_000 }, …)`)
— bun's 5s default is shorter than those helpers' hang guards and than a cold spawn on a loaded machine. After a
short runner timeout, don't `readPid`: the child may be killed before it writes its pid file; check that no process
with the (unique) pid-file path in its argv is left instead.

### Bun 1.3.14 (the pinned version) vs newer bun

`package.json` pins `packageManager: bun@1.3.14` and CI runs exactly that, while a local install is often newer.
The preload and the child-process tests in `tests/preload.test.ts` (which spawn a nested `bun test` with
`process.execPath`, i.e. whatever bun runs the suite) depend on runtime details that differ between versions, and
a newer local bun has passed while CI failed. **Before pushing a change to the preload, `tests/helpers/`, or any test
that spawns `bun test`, run the suite under 1.3.14 too**, from the repo root:

```bash
bunx bun@1.3.14 test          # downloads that bun once, runs the suite with it (nested `bun test` children too)
bunx bun@1.3.14 test tests/preload.test.ts
```

Known differences (found on bun 1.3.14 vs 1.4.1, macOS):

| Behaviour | bun 1.3.14 | bun 1.4.x / node |
| --- | --- | --- |
| `process.on('exit')` / `'beforeExit'` at the normal end of `bun test` | never emitted (only on an explicit `process.exit()`) | emitted |
| A throw from a `node:test` `afterEach` registered in a preload | reported as "Unhandled error between tests"; the test still passes | fails that test |
| A `bun:test` `afterEach`/`afterAll` registered in a preload | applies to every file (`node:test` tests included); `afterAll` runs once, after the last file | same |
| `process.env.X = undefined` (or `null`) | stores the raw value: the key stays present (`'X' in process.env`), reads as `undefined`, and is dropped from a spawned child's env | coerces to the string `"undefined"`/`"null"` |
| Two failing async `node:test` tests (e.g. awaiting a child process) in one file | the *next* file's top-level `test()` calls throw `NotImplementedError: test() inside another test()`, so one real failure can show up as dozens across later files | only the real failures |

So the preload uses `bun:test` hooks (`afterEach` for the backstop, `afterAll` for the pinned-dir cleanup alongside
`'exit'`; `tests/helpers/bun-test.d.ts` declares just those two, since the repo has no `bun-types` dependency),
the backstop treats any non-string env value as coerced, and tests assert on `'X' in process.env` rather than the
value. When a 1.3.14 run reports a wall of `NotImplementedError`s, fix the first real failure above them — the
rest is the cascade.

## Project layout

```
extensions/            # the pi extension
  index.ts             # entry: tool + /delegate command registration, single-run overlay
  engine.ts            # delegate() — the shared single-run engine — and its helpers
  fanout.ts            # fan-out (tool + /delegate all/comma-list), multi-run overlay driver
  history.ts           # /delegate history (+ history-filter.ts: pure filter parsing/applying)
  run-record.ts        # run record sidecar (<transcript>.json): schema, tolerant parser, writer
  rerun.ts             # /delegate rerun: record selection + the pure rerun planner
  fanout-resume.ts     # resume a whole fan-out by its fan-out id
  subcommands.ts       # /delegate list | status | config | config init
  harnesses/           # harness abstraction (claude, codex, opencode, amp, devin) + registry
  runner.ts            # stdout transport: generic runHarness spawn+readline loop
  acp-runner.ts        # ACP transport (devin; opencode opt-in): JSON-RPC handshake over stdio
  command.ts           # /delegate argument parser + fan-out harness resolution
  config.ts            # settings.json loading/provenance/writing, model + transport resolution
  concurrency.ts       # acquireSlot() — the single concurrency choke point
  run-registry.ts      # cross-process active-run registry (one file per run)
  validate.ts          # argv-injection guards + tool allowDangerous confirmation
  activity.ts          # transcripts, reports, metrics, verify + fan-out report rendering
  progress.ts          # single-run progress overlay
  progress-multi.ts    # fan-out multi-run overlay
  notify.ts            # fan-out notification batching
  templates.ts         # frontmatter parsing + template discovery (partitioned, trust-gated)
  usage.ts             # harness usage/cost → pi Usage
templates/             # built-in modes: review, plan, implement, security-audit, docs, general
  shared/ + <harness>/ #   portable prompt bodies + per-harness frontmatter
tests/                 # bun:test unit tests (node:test compatible); fixtures/ holds real captures
docs/                  # design notes and protocol research
scripts/
  check-packables.mjs  # guard: refuses 0.0.0 and empty extensions/ tarball
```

## Changesets

Every PR that touches publishable code needs a changeset:

```bash
bun changeset              # creates .changeset/*.md — commit it
bun changeset --empty      # for no-user-visible changes (docs, CI, tests)
bun changeset status --since=origin/main  # what CI checks
```

The `chore: version packages` PR is the approval gate — it contains version bumps + CHANGELOG entries. Nothing reaches npm without merging it.

## Releasing (maintainers)

Releases are automated via `.github/workflows/release.yml` (changesets + OIDC trusted publishing — no npm token).

```text
PR with changeset → merge to main
  → Release workflow opens/updates `chore: version packages` PR
  → Review version numbers
  → Merge Version Packages PR
  → Release workflow: verify → bun run release (verify + check-packables + changeset publish)
    → creates tag vX.Y.Z pinned to $GITHUB_SHA + GitHub Release
    → verifies `latest` dist-tag
```

First publish of a brand-new package must be done locally with 2FA (`bun run release` prompts), then configure Trusted Publisher on npmjs.com (`Package → Settings → Trusted publisher → GitHub Actions` → `yorch/pi-harness-delegate` + `release.yml`). See the Release process section in `AGENTS.md` for details.

## Testing without pi

The engine runs standalone (only node builtins):

```bash
bun -e "
import { runHarness } from './extensions/runner.ts';
import { claudeHarness } from './extensions/harnesses/claude.ts';
const r = await runHarness({ harness: claudeHarness, prompt: 'Say hi', cwd: process.cwd(), permission: 'readonly', model: 'sonnet' });
console.log(r.result);
"
```

Load-test in pi:

```bash
pi -e /path/to/pi-harness-delegate -p "Reply with exactly: OK" --no-tools
```

### npm publish gotchas (kept for local first publish)

1. Unscoped `pi-harness-delegate` — no `--access public` dance for scoped name; but keep `files: ["extensions","templates"]` so subdirs ship.
2. npm CLI auth needs a **fresh OTP per publish session** (`HttpErrorAuthOTP`). Complete the URL from the error or publish interactively.
3. Registry metadata can **404 for ~2 min after publish** (Cloudflare negative-cache). Wait, don't republish.

## License

MIT — see `LICENSE`.
