import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aliasUsage, COMMAND_FLAGS_HINT, delegateUsage } from '../extensions/command.ts';
import { isTemplateDanger } from '../extensions/harnesses/registry.ts';

test('usage hints share one flag set, including --allow-dangerous and --add-dir', () => {
  for (const flag of [
    '--mode=',
    '--model=',
    '--scope=',
    '--pr=',
    '--budget=',
    '--verify=',
    '--resume=',
    '--add-dir=',
  ]) {
    assert.ok(COMMAND_FLAGS_HINT.includes(flag), flag);
  }
  assert.ok(COMMAND_FLAGS_HINT.includes('--allow-dangerous'));
  assert.ok(delegateUsage().startsWith('/delegate [--harness='));
  assert.ok(delegateUsage().endsWith(COMMAND_FLAGS_HINT));
  for (const cmd of ['claude', 'codex', 'opencode', 'amp', 'omp', 'devin']) {
    assert.equal(aliasUsage(cmd), `/${cmd} ${COMMAND_FLAGS_HINT}`);
  }
});

test('isTemplateDanger: normalized danger and each harness own native danger mode', () => {
  assert.equal(isTemplateDanger('claude', undefined), false);
  assert.equal(isTemplateDanger('claude', { permission: 'danger' }), true);
  assert.equal(isTemplateDanger('claude', { permission: 'edit' }), false);
  assert.equal(isTemplateDanger('claude', { permission: 'readonly' }), false);
  // native escape hatch: normalized tier is `edit`, but the harness's own danger mode is danger
  assert.equal(isTemplateDanger('amp', { permission: 'edit', nativePermission: 'yolo' }), true);
  assert.equal(isTemplateDanger('omp', { permission: 'edit', nativePermission: 'yolo' }), true);
  assert.equal(isTemplateDanger('devin', { permission: 'edit', nativePermission: 'bypass' }), true);
  assert.equal(isTemplateDanger('opencode', { permission: 'edit', nativePermission: 'build --auto' }), true);
  assert.equal(isTemplateDanger('codex', { permission: 'edit', nativePermission: 'danger-full-access' }), true);
  // opencode's bare `build` is its edit tier, not danger
  assert.equal(isTemplateDanger('opencode', { permission: 'edit', nativePermission: 'build' }), false);
  assert.equal(isTemplateDanger('amp', { permission: 'edit', nativePermission: 'write' }), false);
  // an unlisted native value is danger (fail closed), so the banner agrees with the engine's gate
  assert.equal(isTemplateDanger('claude', { permission: 'edit', nativePermission: 'auto' }), true);
  assert.equal(isTemplateDanger('devin', { permission: 'edit', nativePermission: 'smart' }), true);
});

test('isTemplateDanger: every bundled template classifies exactly as its declared tier', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { parseTemplate } = await import('../extensions/templates.ts');
  const root = join(import.meta.dirname, '..', 'templates');
  const harnesses = ['claude', 'codex', 'opencode', 'amp', 'devin'];
  let checked = 0;
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    const files = statSync(dir).isDirectory() ? readdirSync(dir).map(f => join(dir, f)) : [dir];
    for (const file of files.filter(f => f.endsWith('.md'))) {
      const tpl = parseTemplate(readFileSync(file, 'utf8'));
      assert.ok(tpl, file);
      assert.notEqual(tpl.permission, 'danger', file);
      const targets = harnesses.includes(entry) ? [entry] : harnesses;
      for (const h of targets) assert.equal(isTemplateDanger(h, tpl), false, `${file} on ${h}`);
      checked++;
    }
  }
  assert.ok(checked >= 36, `checked ${checked} templates`);
});
