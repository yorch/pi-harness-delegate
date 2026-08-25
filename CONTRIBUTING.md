# Contributing

Development and release notes for `@yorch/pi-claude-delegate`.

## Prerequisites

- Node.js 20+ (any recent LTS)
- `npm` account with access to the `@yorch` scope (for publishing)
- [pi coding agent](https://github.com/badlogic/pi-mono) installed (load-testing)
- `claude` CLI on PATH (for live engine tests)

## Setup and checks

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test + strip-types, 14 tests
```

CI runs both on every push.

## Project layout

```
extensions/            # the pi extension
  index.ts             # tool + /claude command + config + prompt building
  run-claude.ts        # spawns `claude`, streams JSONL, resolves the result
  stream-parse.ts      # pure JSONL parser (unit-tested)
  templates.ts         # frontmatter parsing + template discovery (3 dirs)
  usage.ts             # Claude usage/cost → pi Usage
templates/             # built-in modes: review, plan, implement, security-audit, docs, general
tests/                 # node:test unit tests
```

## Testing without pi

The engine runs standalone (only node builtins):

```bash
node --experimental-strip-types --input-type=module -e "
import { runClaude } from './extensions/run-claude.ts';
const r = await runClaude({ prompt: 'Say hi', cwd: process.cwd(), permissionMode: 'plan', model: 'sonnet' });
console.log(r.result);
"
```

## Releasing

```bash
npm run typecheck && npm test
# bump version in package.json by hand
git add -A && git commit -m "vX.Y.Z: <summary>" && git push
npm publish --access public
pi update --extensions
```

### npm publish gotchas

1. Scoped packages default to **private** — `--access public` is mandatory.
2. npm CLI auth needs a **fresh OTP per publish session** (error `HttpErrorAuthOTP`). Complete the URL from the error or publish interactively; `npm whoami` is not enough.
3. Registry metadata can **404 for ~2 min after publish** (Cloudflare negative-cache). The tarball URL is live immediately — wait, don't republish.

## License

MIT — see `LICENSE`.
