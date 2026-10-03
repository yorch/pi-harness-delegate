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

### Isolating state: `PI_CODING_AGENT_DIR`

Everything this extension reads or writes under `~/.pi/agent` — `settings.json`, user templates
(`delegate/templates/`), transcripts (`delegate/outputs/`), and the active-run registry (`delegate/runs/`) —
resolves from `PI_CODING_AGENT_DIR` when it's set. Tests point it at a temp dir; you can do the same for a
throwaway manual session.

## Project layout

```
extensions/            # the pi extension
  index.ts             # entry: tool + /delegate command registration, single-run overlay
  engine.ts            # delegate() — the shared single-run engine — and its helpers
  fanout.ts            # fan-out (tool + /delegate all/comma-list), multi-run overlay driver
  history.ts           # /delegate history
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
