# pi extension config conventions — survey

**Status:** research · **Written:** 2026-08-30, against `@earendil-works/pi-coding-agent` 0.84.2 and the
npm-installed versions of each surveyed extension listed below. Docs-only; no extension code in this repo
was touched.

**Headline, for anyone skimming:** pi provides **no** official config mechanism for extensions —
confirmed by reading the host package's exported API and its own extension docs, not by absence of a
grep hit. What extensions actually do is genuinely inconsistent on *where* config lives (own file vs. a
key in pi's `settings.json`), but converges hard on *how* to do it safely: validate before use, log or
warn on failure instead of dying silently, and — when writing into a shared file — read-modify-write a
narrow subtree, never a blind overwrite. `pi-harness-delegate`'s current `loadConfig()`
(`extensions/config.ts`) already gets the "shared file" placement half right and the "narrow subtree"
merge right, but is the *only* package surveyed that (a) is read-only — no create/write path at all —
and (b) fails completely silently on malformed JSON, with no log line. Both are gaps relative to every
comparable extension found, not inventions of a new standard.

**Separately, and more urgently:** §5 below documents that this project's project-local-template trust
gate (`isTrusted()`, `extensions/templates.ts`) diverges from pi's real trust model in a way that looks
exploitable, not just non-standard — pi's trust decision lives outside the project directory and cannot
be self-declared by repo content; this project's currently can. That finding is independent of the
config-placement question this survey was originally scoped to, but it came up answering the same "what
does pi's host API actually offer" question, so it's reported here rather than opening a second doc.

## 1. Method

**Host:** `@earendil-works/pi-coding-agent@0.84.2`, read from a real npm install
(`~/.config/yarn/global/node_modules/@earendil-works/pi-coding-agent`, matching the `pi --version` on
this machine) — `dist/index.d.ts` (the public export surface), `dist/core/extensions/types.d.ts` (the
~1300-line `ExtensionContext`/`ExtensionAPI` interface), `dist/core/settings-manager.d.ts`, and
`docs/extensions.md` (the shipped extension-authoring guide). Not the copy under this repo's own
`node_modules` or the sibling worktree's — per this task's isolation rule, everything was read from a
copy outside both forbidden worktrees.

**Extensions surveyed**, chosen from two sources: the user's actual installed-package list
(`~/.pi/agent/settings.json` → `packages`) and an `npm search --json pi-package` sweep for what else
carries the ecosystem's package keyword. Prioritized by real adoption — `npm-api.org` last-30-day
download counts — not by how easy a package was to find:

| Package | Version read | Downloads (30d) |
| --- | --- | --- |
| `pi-mcp-adapter` | 2.31.0 | 761,442 |
| `pi-subagents` | 0.59.0 (0.60.0 latest) | 362,483 |
| `@juicesharp/rpiv-ask-user-question` | installed | 117,275 |
| `pi-lens` | 4.1.3 | 60,127 |
| `pi-simplify` | 0.2.3 | 41,368 |
| `@vigolium/piolium` | 0.0.13 | 4,531 |
| `pi-harness-delegate` (this repo, for scale) | 0.5.0 | 1,286 |
| `@yorch/pi-statusbar` | installed | 1,093 |
| `pi-devin-auth` | 0.1.2 | 334 |

All nine were read as **shipped source**, not README prose — the real npm install tree under
`~/.pi/agent/npm/node_modules/<pkg>` (this machine's actual `pi install`-managed packages, source `.ts`
files, not a minified bundle) for everything except the host package itself, which only ships compiled
`dist/*.d.ts` + `.js`. Where a package's own docs and its code disagreed, code wins; no such disagreement
turned up here (unlike this project's past experience with harness CLI docs).

`npm search` also surfaced a long tail of very-low-adoption `pi-package`-tagged packages (`pi-spark`,
`@outlit/pi`, `pi-subagents-j0k3r`, `@eko24ive/pi-ask`, …) not included in the table — skimmed for
config approach only where distinctive; none showed a pattern not already covered by the table above.

## 2. Does pi provide an official config mechanism? — **No.**

This is the load-bearing finding, so the evidence in full:

**`SettingsManager` exists and is exported, but it is pi's own store, not extension-accessible.**
`dist/index.d.ts` re-exports `SettingsManager` from `./core/settings-manager.ts` — a real, well-built
class: file-locked writes (`FileSettingsStorage.withLock`), global+project scope, typed getters/setters
per field, and a `modifiedFields` tracker so `save()` only ever touches the keys this process actually
changed (never a blind overwrite of the whole file). But its `Settings` interface
(`dist/core/settings-manager.d.ts`) is a **closed set** of pi's own ~50 fields — `theme`,
`defaultProvider`, `packages`, `extensions`, `compaction`, `tuiMode`, etc. — with no index signature and
no extension namespace. Nothing in it resembles this project's `delegate` key. It is not exposed to
extensions at all: `ExtensionContext` and `ExtensionAPI` (`dist/core/extensions/types.d.ts`, read in
full) have **zero** settings/config accessor — no `ctx.settings`, no `pi.config`, nothing. An extension
that wanted to use `SettingsManager` would have to import and instantiate it itself, then cast past the
type system to touch a key the type doesn't declare — not a supported path, an accident of it being a
public export.

**The one piece of official guidance points extensions at their own file, not at pi's settings.json.**
`docs/extensions.md`, the `ctx.cwd` section:

> Use `CONFIG_DIR_NAME` instead of hardcoding `.pi` when constructing project-local config paths.
> ```typescript
> const projectConfigPath = join(ctx.cwd, CONFIG_DIR_NAME, "my-extension.json");
> ```
> Use [`ctx.isProjectTrusted()`] before reading project-local extension configuration that should only
> be honored for trusted projects.

That's the entire official story: read your own JSON file under `.pi/<name>.json`, gated by trust for
reads. No write helper, no global/user-level equivalent, no schema/validation helper, nothing about
`settings.json` as a place for extension keys. The only other `settings.json` mention in the whole
extensions doc is the unrelated `packages`/`extensions` arrays (where pi itself discovers extensions to
load) — never framed as a place for an extension's *own* settings.

**Conclusion:** there is no sanctioned "put your config in pi's settings.json" pattern, and no
sanctioned writer/schema helper for extensions at all. Every extension below rolled its own — which is
exactly why §6 asks whether a de-facto convention formed anyway.

## 3. Per-extension findings

### `pi-mcp-adapter` (761k/mo) — own file, layered, atomic writes, no `settings.json`

Never touches `settings.json`. Its config is **its own dedicated file**, `~/.pi/agent/mcp.json`
(`getPiGlobalConfigPath` → `getAgentPath("mcp.json")`, `config.ts`), deliberately outside pi's shared
settings file. Layered across up to five sources with documented precedence (`getConfigSources`,
`config.ts:414`): a generic cross-tool `~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, pi's own global
`mcp.json`, project `.mcp.json` (the same filename Claude Code/Cursor use — genuine interop, not just a
convention name), and a project-local `.pi/mcp.json` override. Also imports and reads (without merging
writes into) host configs from six other tools (Cursor, Claude Code, Claude Desktop, Codex, OpenCode,
Windsurf, VS Code) when `hostConfigDiscovery` is opted in.

- **Validation/failure:** `readValidatedConfig` wraps every parse in try/catch, `console.warn`s with the
  file path and the underlying error, and falls back to an empty config — never throws, never silent.
- **Writes:** every writer (`writeRawConfigObject`) writes to `<path>.<pid>.tmp` then `renameSync`s over
  the target — atomic on POSIX, no torn-file risk if the process dies mid-write. Every mutation reads the
  full raw file first and only touches the keys it means to (`writeProjectServerDisabledOverride` is a
  good example: it round-trips the untouched parts of an existing file, including someone else's
  `imports` array, ~30 lines of care to avoid clobbering).
- **Discoverability:** a `previewCompatibilityImports`/`buildConfigWritePreview` pair generates a unified
  diff (hand-rolled LCS-based, `buildUnifiedDiff`) *before* any write actually happens, presumably shown
  to the user through a `/mcp` panel command (`mcp-panel.ts`, not read in full).
- **Migration:** none needed in the classic sense — the whole design is "layer in whatever the other
  tools already wrote," so there's no legacy-key migration, just source precedence.

### `pi-subagents` (362k/mo) — dual surface: own file *and* a namespaced settings.json key

The richest example, and the one most structurally similar to what `pi-harness-delegate` should look
like. Two independent config surfaces, used for different things:

1. **Its own file**, `~/.pi/agent/extensions/subagent/config.json` (`getConfigPath`,
   `src/extension/config.ts`) — the bulk of its ~50 settings (concurrency limits, timeouts, fleet UI,
   worktree behavior, mission store, …).
2. **A namespaced key inside pi's `settings.json`**, `subagents.*` — but *specifically* for the watchdog
   subsystem (`src/watchdog/settings.ts`), and read from **both** the global `~/.pi/agent/settings.json`
   **and** a project-local `.pi/settings.json`/`.agents/settings.json` (walked upward from cwd) — pi
   itself supports project-scoped settings files, which this project's `loadConfig()` does not currently
   read at all.

Both surfaces share the same discipline:

- **Validation:** exhaustive, hand-written per-field validators with descriptive `Error` messages
  (`config.forkContext.mode must be "full" or "pruned"`, ~15 such functions in `config.ts`) — not a
  generic schema library, but every field is checked, and unknown keys inside a known sub-object are
  rejected (`assertKnownFields` in `watchdog/settings.ts`) so a typo surfaces immediately instead of
  silently doing nothing.
- **Failure:** `loadConfig()`'s outer catch does `console.error(...)` with the file path and the original
  error before falling back to `{}` — a malformed file is *loud*, unlike a bare `catch {}`.
- **Writes:** `saveConfig`/`updateConfig(updater)` (read → apply updater → validate → write) for the own
  file; `writeUserWatchdogEnabled`/`writeWatchdogModelSettingsWrite` for the settings.json key, which
  read the whole settings object, `ensureObjectField` only the `subagents.watchdog` subtree, and write
  the whole object back — never a blind overwrite of sibling keys.
- **Discoverability:** `/subagents-doctor` ("Show subagent diagnostics") is a dedicated diagnostic slash
  command; 18 other `subagents-*` commands exist for adjacent state (`/subagents-profiles`,
  `/subagents-models`, …). No single "print effective config" command was confirmed, but the doctor
  command is the closest thing surveyed to a discoverability primitive.
- **Migration:** `docs/configuration.md` documents a `.pi/settings.json` vs. nearest-`.pi`-dir resolution
  toggle (`subagents.projectRootResolution`) for monorepo/worktree edge cases — a real, documented
  migration/compat knob, not silent.

### `pi-lens` (60k/mo) — own dotfile *outside* `~/.pi/`, four-tier precedence, one flag registry

Its own file, and not even under `~/.pi/`: `~/.pi-lens/config.json` (a top-level home dotfile). Adds a
**project-local** `.pi-lens.json`/`pi-lens.json`, walked upward from cwd (monorepo-friendly, same idea as
pi-subagents' project root resolution). Four-tier resolution per toggle, documented explicitly in
`docs/globalconfig.md`: env var > CLI flag > nearest project file (for three specific mutation-control
keys only) > global config.json > built-in default.

- **Validation/failure:** "Missing or invalid config falls back to defaults." An unrecognized *top-level*
  key is logged once (not fatal, not silent) specifically to catch typos (`lps` for `lsp` is the
  doc's own example) — a deliberately different tier from a genuinely malformed file. A project file
  setting a **user-level-only** key is not silently dropped either: it's rejected with a one-time logged
  warning explaining that key is honored only at global scope. This is the most granular
  "explain exactly what went wrong and why" behavior of anything surveyed.
- **No arbitrary settings.json key at all** — confirms MCP-adapter and pi-lens (the two highest-adoption
  packages with a rich config surface, after pi-subagents) both independently chose "own file", not "key
  in pi's file."
- **Discoverability/no-drift-by-construction:** every runtime toggle is settable from *both* the CLI flag
  and `config.json`, driven off one declarative registry (`clients/lens-flag-registry.ts`) — the doc
  states this exists specifically so "neither surface can gain a toggle the other lacks." A `$schema`
  key is always tolerated for editor JSON-schema association, implying a real JSON Schema ships
  somewhere for IDE autocomplete (not independently confirmed by reading the schema file itself).

### `@yorch/pi-statusbar` (1.1k/mo, same author as this repo) — key in `settings.json`, and **writable**

The closest existing precedent to this project's own approach, and worth reading carefully because it's
also the strongest evidence that "a key in pi's settings.json" is not unprecedented — but it closes
exactly the gap `pi-harness-delegate` currently has. Config lives at `settings.statusbar` inside pi's
own `~/.pi/agent/settings.json`. `loadConfig()` (`extensions/index.ts`) is structurally almost identical
to this repo's `loadConfig()` — same defaults object, same per-field `typeof` checks before merging, same
bare `catch { /* invalid settings file — fall back to defaults */ }`. The difference: **it's writable.**
`savePreset()` reads the whole settings file (or `{}` if absent), replaces only `settings.statusbar`,
writes to `<file>.tmp`, then `renameSync`s over the target — atomic, and every other top-level key in
`settings.json` survives untouched. It's wired to a `/statusbar <preset>` command, so a user gets a
guided way to change config without hand-editing JSON, and the command's own notify line
(`"saved to settings.json"`) tells them exactly what happened and where.

### `@juicesharp/rpiv-ask-user-question` (117k/mo) — own XDG file via a shared config library

Its own file, `~/.config/rpiv-ask-user-question/config.json`, resolved through an actual **shared
library published for this purpose**: `@juicesharp/rpiv-config`'s `loadJsonConfigWithLegacyFallback()`.
That a config-loading helper exists as an installable dependency at all is itself a signal that no single
official mechanism has filled this gap — a third party built one. Behavior (per
`docs/configuration.md`, cross-checked against the one call site in `config.ts`): `$XDG_CONFIG_HOME`
first, then the legacy fixed path, else all defaults; malformed JSON warns on stderr and falls back;
valid-JSON-but-wrong-shape (a string/array/number at the root, or an individual field with the wrong
type) is dropped **silently**, no warning — a narrower silent-failure zone than this project's current
"anything wrong = silent," but not zero. Read-only: "This package only ever *reads* the file; it never
creates, writes or chmods it."

### `pi-simplify` (41k/mo) and `pi-devin-auth` (334/mo) — no config at all

Both legitimately have none. `pi-simplify` registers one slash command and reads nothing persisted.
`pi-devin-auth` persists nothing extension-side — model catalog caching and OAuth tokens are handled by
pi's own credential store (`ctx.modelRegistry`/OAuth flow), not a file this package owns. Useful
negative data point: plenty of real, adopted extensions need no config surface whatsoever, and inventing
one when there's nothing to configure would be over-engineering.

### `@vigolium/piolium` (4.5k/mo) — no persistent config found

A large extension (40+ files, its own audit-orchestration engine) that calls the host's `getAgentDir()`
only to locate subagent working directories, not to read/write its own settings. No `settings.json` key,
no own file found via grep across its `extensions/piolium/` tree. State appears to be session-scoped
(phase/mode driven by command args and `appendEntry`-style session persistence per the official
extension-docs pattern), not a config file.

## 4. Comparison table

| Package | Where config lives | Created by | Validation | Failure mode | Discoverability | Migration |
| --- | --- | --- | --- | --- | --- | --- |
| **pi (host)** | n/a — `SettingsManager` is host-internal, not extension-facing | n/a | typed getters/setters | n/a | `docs/extensions.md` says "own file under `.pi/`" | `migrations.ts` (host's own legacy keys) |
| `pi-mcp-adapter` | own file `~/.pi/agent/mcp.json` + project `.mcp.json`/`.pi/mcp.json` + cross-tool imports | hand-edit, or a `/mcp` panel writer | full parse validation per source | `console.warn`, skip that source | diff preview before write; discovery summary | source-precedence layering, not key migration |
| `pi-subagents` | own file `.../extensions/subagent/config.json` **+** `subagents.*` key in `settings.json` (global & project) | hand-edit, or `updateConfig()`/watchdog writers | exhaustive per-field validators, unknown-key rejection | `console.error` + fall back to `{}`/defaults | `/subagents-doctor` + 18 other commands | documented `projectRootResolution` compat knob |
| `pi-lens` | own dotfile `~/.pi-lens/config.json` + project `.pi-lens.json` (walked up) + env + CLI | hand-edit only (no writer found) | per-key type checks; one-time warn on unknown/misplaced key | warn once, fall back to default for that key | one flag registry drives CLI+config docs identically | key-scope-mismatch warning (user-only key in project file) |
| `@yorch/pi-statusbar` | key `statusbar` in pi's `settings.json` | hand-edit, or `/statusbar <preset>` | per-field `typeof` checks | silent `catch {}` → defaults | `/statusbar` command, notifies on save | none needed (no legacy key) |
| `@juicesharp/rpiv-ask-user-question` | own file, XDG (`~/.config/rpiv-ask-user-question/config.json`) via shared `@juicesharp/rpiv-config` lib | hand-edit only, read-only lib | shape check at root; per-field type check | stderr warn (malformed JSON) or silent (wrong shape/type) → defaults | docs table only | XDG-path-wins-over-legacy-path rule |
| `pi-simplify` / `pi-devin-auth` | none | n/a | n/a | n/a | n/a | n/a |
| `@vigolium/piolium` | none found (session-scoped state only) | n/a | n/a | n/a | n/a | n/a |
| **`pi-harness-delegate` (this repo, today)** | key `delegate` in pi's `settings.json` | **hand-edit only — no writer, no command** | per-field `typeof`/range checks (decent) | **fully silent `catch {}`** → defaults | README only | `claudeDelegate` → `delegate` migration exists, but **returns early**, silently dropping newer fields for anyone still on the legacy key |

## 5. Project trust: `ctx.isProjectTrusted()` vs. this project's hand-rolled gate

Requested follow-up, and the single most consequential finding in this survey after §2 — this is a
security-gate correctness question, not a style question, so the evidence is laid out in full rather
than summarized.

**This project's gate.** `extensions/templates.ts:143`, `isTrusted(cwd)`, guards whether project-local
delegate templates (`.pi/delegate/templates/`) load at all — and those templates can set
`permission: danger` and ship a `verify:` command that `resolveVerifyPlan` runs host-side after the
harness exits (see AGENTS.md's "Verify" bullet). It resolves as:

```ts
function isTrusted(cwd: string): boolean {
  if (process.env.PI_TRUSTED === '1' || process.env.PI_DELEGATE_TRUSTED === '1') return true;
  try {
    return readFileSync(join(cwd, '.pi', 'trusted'), 'utf8').trim() === '1';
  } catch {
    return false;
  }
}
```

The env-var path is fine — it's under the operator's own control. **The file path is not**: it reads
`<cwd>/.pi/trusted`, a path *inside the project directory being evaluated for trust*. Nothing stops that
file from being part of the repository's own committed content.

**pi's real trust model** (`ctx.isProjectTrusted()`, `ExtensionContext`, confirmed reachable and real —
`dist/core/extensions/types.d.ts:232`) is backed by `ProjectTrustStore`
(`dist/core/trust-manager.js`, `dist/core/trust-manager.d.ts`), read from decompiled source:

- The store file is `join(agentDir, "trust.json")` (`trust-manager.js:172`) — i.e.
  `~/.pi/agent/trust.json` by default. **Outside any project directory**, in pi's own global config dir.
- It's a flat JSON object keyed by **canonicalized absolute path** → `true`/`false`
  (`normalizeCwd`/`canonicalizePath`, `trust-manager.js:16-17`).
- Lookup walks **upward** from `cwd` through parent directories until it finds an explicit entry
  (`findNearestTrustEntry`, `trust-manager.js:19-30`) — so trusting a parent folder cascades to
  subdirectories, but there is no path by which a *descendant* (the project itself) can inject an entry.
- A decision is only ever written by: an interactive "Trust" / "Trust parent folder" / "Do not trust"
  prompt (`getProjectTrustOptions`, offering exactly those choices plus a session-only option), the
  user's own `defaultProjectTrust` setting (`"ask" | "always" | "never"`, part of pi's own closed
  `Settings` type — a global preference, not something a cloned repo can set for itself), or a
  `project_trust` extension handler — and that event fires **only for user/global-scope or CLI `-e`
  extensions**; `docs/extensions.md:354` states plainly that "project-local extensions are not loaded
  until after trust is resolved," closing the obvious circularity (a project can't ship an extension
  that grants itself trust). pi's own `hasTrustRequiringProjectResources` gate additionally treats a
  project's own `settings.json` as itself trust-requiring content — so even pi's project-scoped
  *settings* can't be read pre-trust, let alone used to grant it.
- `ctx.isProjectTrusted()` layers in "temporary trust decisions and CLI trust overrides" on top of the
  saved file (`docs/extensions.md:969`) — a strictly larger notion of trust than the saved store alone,
  but every source that feeds it is still anchored outside the project's own repo content.

**The divergence, stated plainly:** pi's trust decision cannot be self-declared by the thing being
evaluated. This project's can — `<cwd>/.pi/trusted` is repo content, and a `git clone` of an untrusted
or actively malicious repository can ship that file pre-committed with the byte `1`. If that repo is
cloned and `/delegate` is run from inside it, `isTrusted()` returns `true` on the **first** invocation,
with no prompt, no env var, and no prior human decision — at which point `loadTemplates()` (line 176)
loads that same repo's `.pi/delegate/templates/`, which can define `permission: danger` and a `verify:`
command that executes on the host. This reads as a real, low-effort-to-exploit gap in exactly the
control this project's own `templates.ts` comment says it exists for ("untrusted clones must not
override builtins") — not a style mismatch with pi's convention, but the convention pi uses specifically
to prevent this class of bug.

**Do any surveyed extensions use `ctx.isProjectTrusted()`?** No — zero hits for
`isProjectTrusted`/`project_trust`/`ProjectTrust` across all eight surveyed extensions' source
(`pi-subagents`, `pi-mcp-adapter`, `pi-simplify`, `pi-lens`, `pi-devin-auth`,
`@juicesharp/rpiv-ask-user-question`, `@vigolium/piolium`, `@yorch/pi-statusbar`), including
`pi-subagents`, the one package that also reads a project-local settings file
(`.pi/settings.json`/`.agents/settings.json` for its `subagents.watchdog` key, §3 above) — it does not
gate that read on trust at all, as far as this survey found. So this project is not alone in skipping
the official trust hook; it's alone (among those surveyed) in having built a *replacement* gate whose
trust anchor is inside the thing it's gating. Skipping the check entirely (pi-subagents' apparent
approach for a lower-stakes settings key) and building a broken version of the check are different bugs
— the second is worse here because this project's own gate exists specifically to block exactly the
`permission: danger` / `verify:` escalation path its docstring names.

This project was told **not** to change `isTrusted()` in the current PR — a security gate deserves its
own change with its own tests, decided with this evidence in hand, not folded into a docs PR.

## 6. The convention, if there is one

**No convention on placement.** Three of the five extensions with a real config surface use their own
dedicated file (`pi-mcp-adapter`, `pi-lens`, `@juicesharp/...`); one uses only a `settings.json` key
(`@yorch/pi-statusbar`); one uses both, for different subsystems (`pi-subagents`). Own-file is somewhat
more common among the higher-adoption / larger-surface packages, but not exclusively — and it tracks a
sensible split rather than fashion: packages with a config surface other tools also produce/consume
(`pi-mcp-adapter`'s `mcp.json`, which is a de-facto cross-tool standard filename) or a large/growing
schema (`pi-subagents`, `pi-lens`) reach for their own file; packages with a handful of simple toggles
(`pi-statusbar`) are content inside `settings.json`. This project's `delegate` config (9 top-level
fields, one nested `harnesses` map) sits closer to the "small, settings.json is fine" end of that
spectrum than the "own file" end — so placement is not something this survey found a strong reason to
change.

**A real convention on behavior, though:** every package surveyed with a config surface — regardless of
where the file lives — does three things this project's `loadConfig()` does not:

1. **Logs or warns on a malformed/invalid file**, rather than failing completely silently. `pi-subagents`
   (`console.error`), `pi-mcp-adapter` (`console.warn`), `pi-lens` (warn-once per bad key),
   `@juicesharp/...` (stderr warn for malformed JSON specifically). This project's bare
   `catch { /* invalid settings — fall back to defaults */ }` is the **only** silent one of the group.
2. **Never blindly overwrites the shared file when it writes** — every writer that touches
   `settings.json` or another shared file (`pi-subagents`' watchdog writers, `pi-statusbar`'s
   `savePreset`, `pi-mcp-adapter`'s raw-config writers) reads the whole file first and replaces only its
   own subtree. This project's `loadConfig()` already reads correctly this way (never mind writing, since
   it doesn't write at all) — the merge logic in `extensions/config.ts` is fine and matches the
   ecosystem's care level.
3. **Offers *some* writer or command**, not hand-edit-only, once the config surface is more than a
   handful of toggles. `pi-subagents` (`updateConfig`), `pi-mcp-adapter` (panel + preview writers),
   `pi-statusbar` (`/statusbar <preset>`) all give the user a guided path; only the read-only-by-design
   `@juicesharp/...` package and this project are hand-edit-only, and that package is read-only
   *by explicit design choice*, stated in its own docs — not an oversight.

So: **pi itself has no opinion, but the ecosystem has an unwritten quality bar for "loud on failure,
narrow on write, don't make the user hand-edit JSON forever" that this project currently misses on two
of three.**

## 7. Recommendations for `pi-harness-delegate`

**Scope check requested: does anyone store genuinely global/user-level preferences, or does everyone
piggyback on pi's `settings.json`?** This project's config is global by nature (harness models,
concurrency caps, transport selection — none of it is naturally per-project), so the question is worth
answering explicitly rather than folding into §6's placement verdict. Answer: **every single extension
surveyed that has any config at all has a global/user-level tier** — "nobody else has global config" is
false. But *how* they store that global tier splits along the same own-file-vs-settings.json-key line as
§6, it doesn't resolve it:

| Package | Global config location | Also has a project tier? |
| --- | --- | --- |
| `pi-mcp-adapter` | own file, `~/.pi/agent/mcp.json` ("Pi global override" source) | yes — `.mcp.json`/`.pi/mcp.json` |
| `pi-subagents` | own file, `.../extensions/subagent/config.json`, for most settings | yes — `subagents.watchdog` in project `.pi/settings.json` too |
| `pi-lens` | own file, `~/.pi-lens/config.json` (outside `~/.pi/` entirely) | yes — `.pi-lens.json` walked upward |
| `@juicesharp/rpiv-ask-user-question` | own file, XDG `~/.config/rpiv-ask-user-question/config.json` | **no** — global-only, no project variant at all |
| `@yorch/pi-statusbar` | key `statusbar` in pi's `~/.pi/agent/settings.json` | **no** — global-only, no project variant at all |

So the honest verdict, not manufactured: three own-file packages layer project-level on top of a global
base; two settings.json-key packages (including this project's closest precedent, `pi-statusbar`, same
author) are global-only with no project tier and see no need for one. `pi-harness-delegate` today is
also global-only, no project tier — that puts it in the same bucket as `pi-statusbar` and
`@juicesharp/...`, not an outlier. Nothing here argues for adding project-scoped config (§7 item 5 below
still frames it as optional, driven by actual need) or for moving off `settings.json` — if anything, the
two global-only precedents both landed on "key in settings.json" or "own tiny file," and this project's
existing choice matches one of those two exactly.

Prioritized; each states what's already fine so the parallel `feat/config-ux` implementation doesn't
redo settled ground.

0. **(Security, out of this survey's original scope, escalated because §5 found it here) Fix the
   project-template trust gate before it's relied on further.** `isTrusted()`'s file-based check reads
   trust from inside the project it's evaluating — the opposite of pi's own model, which anchors every
   decision in `~/.pi/agent/trust.json`, outside the project, unwritable by repo content. This is not a
   convention mismatch, it's the specific bug pi's model is designed to prevent. Not this PR's job to
   fix (see §5's close) — flagged at priority 0 because it's a correctness/security issue, not a UX
   preference, and should be triaged and scheduled independently of the config-UX work, ideally before
   any change that makes project-local templates more prominent or easier to reach.
1. **Stop failing silently on a malformed/invalid `settings.json`.** Every comparable extension logs.
   Add a `console.error`/`console.warn` (matching `pi-subagents`'/`pi-mcp-adapter`'s style) inside the
   `catch` in `loadConfig()` (`extensions/config.ts:158`) naming the file path and the underlying error,
   before falling back to defaults. This is the single highest-value, lowest-risk change — it's the one
   place this project is a clear outlier against every package surveyed, not just a judgment call.
2. **Fix the legacy-migration early-return.** `loadConfig()`'s `claudeDelegate` branch
   (`extensions/config.ts:77-116`) returns immediately after migrating, so a user still on the legacy key
   gets *only* the fields that branch explicitly maps — any newer `delegate`-only field silently doesn't
   exist for them. `pi-subagents`' `projectRootResolution` compat knob and `pi-mcp-adapter`'s
   layered-precedence model both show the ecosystem's expectation: legacy input should degrade gracefully
   into the *current* full feature set, not a frozen subset. At minimum, log that the user is on a
   deprecated key (`pi-subagents`' loud-on-load-error precedent) so this doesn't require the person
   reading `extensions/config.ts` to notice.
3. **Give the config surface a writer and a command**, matching `pi-statusbar`'s `/statusbar <preset>`
   and `pi-subagents`' `updateConfig()`. A `/delegate config <key> <value>` (or similar) that reads
   `settings.json` whole, replaces only `settings.delegate.<key>`, writes via tmp-file-then-rename
   (`pi-mcp-adapter`'s and `pi-statusbar`'s pattern — both proven, atomic, and small to port), is the
   ecosystem's answer to "don't make users hand-edit JSON forever." This is the one item most likely to
   collide with what `feat/config-ux` is already building — flag it there explicitly, not just here.
4. **Placement (key-in-settings.json vs. own file) is fine as-is — do not migrate it.** No dominant
   convention exists either way, and this project's config (9 flat-ish fields) is closer in shape to
   `pi-statusbar`'s than to `pi-mcp-adapter`'s or `pi-lens`'s sprawling schemas that justified their own
   files. Moving to an own file would be churn without a clear win; revisit only if the config surface
   grows the way `pi-subagents`' did (at which point its own dual-surface split — small/simple stays in
   `settings.json`, a large/specific subsystem gets its own file — is the precedent to follow, not a full
   migration).
5. **Consider project-local settings**, since this repo's `loadConfig()` only ever reads the global
   `~/.pi/agent/settings.json`. `pi-subagents` reads project-local `.pi/settings.json`/`.agents/settings.json`
   (walked upward from cwd) for its `subagents.watchdog` key on top of the global file, and pi's own
   `SettingsManager` supports a project scope natively. Worth doing only if there's an actual per-project
   need (e.g., a project wanting a different `defaultHarness` or `maxConcurrent` than the user's global
   default) — not asserted here as a gap, just flagged as a precedent that exists if the need comes up.
6. **A discoverability command is worth adding but is lower priority than #1–#3.** `/subagents-doctor`
   and `/statusbar`'s save-confirmation notify are the two closest precedents for "let the user see
   current effective config without opening JSON." This project already has `/delegate list`/`history`/
   `status`; a `/delegate config` (show, per #3) would fold into the same family rather than needing a
   new command.

## 8. Open questions / could not verify

- **Whether `isTrusted()`'s divergence (§5) has already been exploited or discussed** was not
  researched — no issue-tracker or commit-history search was performed for this survey; the finding is
  purely from reading current code against pi's current trust model.
- **Whether `hasTrustRequiringProjectResources` or any other pi-side gate incidentally blocks this
  project's `.pi/delegate/templates/`** (e.g. because `.pi/` itself triggers something upstream before
  this project's own `isTrusted()` ever runs) was not verified by an actual clone-and-run repro — the
  finding is from reading `trust-manager.js`/`.d.ts` and this project's `templates.ts` side by side, not
  from an end-to-end exploit demonstration. A real repro (clone a repo with a committed
  `.pi/trusted` containing `1` and a `.pi/delegate/templates/` entry, run `/delegate` in it fresh) would
  make this conclusive rather than source-level-confident.
- **`pi-lens`'s `$schema` support** implies a real JSON Schema file ships for editor autocomplete, but the
  schema file itself was not located/read — only the doc's mention of tolerating the key.
- **`pi-mcp-adapter`'s `/mcp` panel UI** (`mcp-panel.ts`, `mcp-setup-panel.ts`) was not read in full — the
  claim that it surfaces `buildConfigWritePreview`'s diff to the user is inferred from the function's
  existence and naming, not confirmed by reading the panel's render code.
- **Whether any surveyed package ships a `SettingsManager`-based extension config** (i.e., actually
  imports and uses the host's exported class rather than raw `fs` calls) was not found in any of the
  nine — plausible nobody does this given it's not designed for the purpose (§2), but not exhaustively
  ruled out beyond these nine.
- **The long tail of low-adoption `pi-package` packages** from the `npm search` sweep (`pi-spark`,
  `@outlit/pi`, `pi-subagents-j0k3r`, `@eko24ive/pi-ask`, and others) were not read in source depth —
  skimmed by name/description only. Given their adoption is a fraction of a percent of the packages
  actually surveyed, this is judged not to change the convention verdict in §6, but is explicitly not a
  claim that every pi extension in existence was checked.
- **pi's roadmap**: whether an official extension-config mechanism is planned upstream was not
  researched (no changelog/issue-tracker search performed) — this survey only establishes the *current*
  state of `0.84.2`.
