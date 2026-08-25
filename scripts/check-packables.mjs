#!/usr/bin/env node
// Guard rail for `pi-harness-delegate` (single-package, no dist build).
// Replicates invariants from colophon/repo-release-process.md §5, adapted for
// this repo's `files: ["extensions","templates","README.md","LICENSE"]`.
// - Refuses `0.0.0` placeholder (would permanently point `latest` at 0.0.0 on first publish).
// - Refuses empty tarball: asserts at least one file under `extensions/` in the pack.
// Does NOT check registry - `changeset publish` already skips already-published versions.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function fail(msg) {
  console.error(`check-packables: ${msg}`);
  process.exit(1);
}

const manifestRaw = readFileSync('package.json', 'utf8');
const manifest = JSON.parse(manifestRaw);
const { name, version } = manifest;

if (!name || !version) fail('package.json missing name or version');

if (version === '0.0.0') {
  fail(
    `Refusing to publish ${name}@${version} — placeholder 0.0.0. ` +
      'Run `bun run version-packages` (changesets) to bump the version first. ' +
      'Publishing 0.0.0 would burn the version and, on first publish, pin `latest` to 0.0.0.',
  );
}

// Run pack dry-run and inspect file list. Prefer `npm pack --dry-run --json`
// (matches the publish tool); fall back to `bun pm pack` output if needed.
let packOutput;
try {
  packOutput = execSync('npm pack --dry-run --json 2>/dev/null', { encoding: 'utf8' });
} catch (e) {
  // npm <10 doesn't support --json; try bun alternative
  try {
    packOutput = execSync('bun pm pack --dry-run 2>/dev/null', { encoding: 'utf8' });
    // bun pm pack lists files one per line, not JSON - synthesize JSON shape
    const files = packOutput
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(f => ({ path: f }));
    if (files.length === 0) fail('pack produced no files');
    const hasExtensions = files.some(f => f.path.startsWith('extensions/'));
    if (!hasExtensions) {
      fail(
        `Tarball for ${name}@${version} contains no files under extensions/. ` +
          'The publish would ship an empty package (npm does not error on empty tarballs). ' +
          'Check `files` in package.json and that extensions/ exists.',
      );
    }
    console.log(`check-packables: ${name}@${version} — pack contains ${files.length} files, including extensions/ ✓`);
    process.exit(0);
  } catch {
    fail(`Failed to run pack dry-run: ${e.message}`);
  }
}

let parsed;
try {
  parsed = JSON.parse(packOutput);
} catch (e) {
  fail(`Failed to parse pack output as JSON: ${e.message}\n${packOutput.slice(0, 2000)}`);
}

// npm pack --json returns [{id, name, version, files: [{path,size}]}]
const entry = Array.isArray(parsed) ? parsed[0] : parsed;
const files = entry?.files ?? [];
if (!Array.isArray(files) || files.length === 0) {
  fail(`pack for ${name}@${version} produced no files`);
}

const hasExtensions = files.some(f => (f.path ?? f).startsWith('extensions/'));
if (!hasExtensions) {
  const list = files
    .slice(0, 20)
    .map(f => `  - ${f.path ?? f}`)
    .join('\n');
  fail(
    `Tarball for ${name}@${version} contains no files under extensions/. ` +
      'The publish would ship an empty package.\n' +
      `First 20 files in tarball:\n${list}`,
  );
}

console.log(`check-packables: ${name}@${version} — pack contains ${files.length} files, including extensions/ ✓`);
