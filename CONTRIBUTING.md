# Contributing

Development and release notes for `pi-harness-delegate`.

## Prerequisites

- Node.js 26
- Bun 1.3.14 (`curl -fsSL https://bun.sh/install | bash`)
- `npm` account (publishing goes through OIDC trusted publishing — no token needed for CI)
- [pi coding agent](https://github.com/badlogic/pi-mono) installed (load-testing)
- `claude`/`codex`/`opencode`/`amp` CLIs on PATH (for live engine tests)

## Setup and checks

```bash
bun install
bun run lint        # Biome check (2 spaces, 120 cols, single quotes)
bun run lint:fix    # auto-fix
bun run typecheck   # tsc --noEmit
bun test            # bun:test (node:test compatible), 123 tests
bun run verify      # lint + typecheck + test (also runs in CI/release)
```

CI runs `verify` + `check-packables` + changeset presence on every push/PR (`.github/workflows/ci.yml`).

## Project layout

```
extensions/            # the pi extension
  index.ts             # tool + /delegate command + config + prompt building
  harnesses/           # harness abstraction (claude, codex, opencode, amp)
  runner.ts            # generic runHarness spawn+readline loop
  templates.ts         # frontmatter parsing + template discovery (partitioned)
  usage.ts             # harness usage/cost → pi Usage
templates/             # built-in modes: review, plan, implement, security-audit, docs, general
tests/                 # bun:test unit tests (node:test compatible)
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
  → Release workflow: verify → bun run release (typecheck + check-packables + changeset publish)
    → creates tag vX.Y.Z pinned to $GITHUB_SHA + GitHub Release
    → verifies `latest` dist-tag
```

First publish of a brand-new package must be done locally with 2FA (`bun run release` prompts), then configure Trusted Publisher on npmjs.com (`Package → Settings → Trusted publisher → GitHub Actions` → `yorch/pi-harness-delegate` + `release.yml`). See `repo-release-process.md` for details.

## Testing without pi

The engine runs standalone (only node builtins):

```bash
bun --experimental-strip-types --input-type=module -e "
import { runHarness } from './extensions/runner.ts';
import { claudeHarness } from './extensions/harnesses/claude.ts';
const r = await runHarness(claudeHarness, { prompt: 'Say hi', cwd: process.cwd(), permission: 'readonly', model: 'sonnet' });
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
