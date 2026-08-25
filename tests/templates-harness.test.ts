import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTemplate } from '../extensions/templates.ts';

test('parseTemplate permission normalized readonly', () => {
	const t = parseTemplate('---\nname: x\npermission: readonly\n---\nbody');
	assert.equal(t!.permission, 'readonly');
	assert.equal(t!.permissionMode, 'plan');
});

test('parseTemplate permission normalized edit', () => {
	const t = parseTemplate('---\nname: x\npermission: edit\n---\nbody');
	assert.equal(t!.permission, 'edit');
});

test('parseTemplate permission normalized danger', () => {
	const t = parseTemplate('---\nname: x\npermission: danger\n---\nbody');
	assert.equal(t!.permission, 'danger');
	assert.equal(t!.permissionMode, 'bypassPermissions');
});

test('parseTemplate legacy permissionMode plan maps to readonly', () => {
	const t = parseTemplate('---\nname: x\npermissionMode: plan\n---\nbody');
	assert.equal(t!.permission, 'readonly');
});

test('parseTemplate native escape hatch preserves nativePermission', () => {
	const t = parseTemplate('---\nname: x\npermission: some-native-flag\n---\nbody');
	assert.equal(t!.nativePermission, 'some-native-flag');
	assert.equal(t!.permission, 'edit');
});

test('parseTemplate permission: read-only maps to readonly', () => {
	const t = parseTemplate('---\nname: x\npermission: read-only\n---\nbody');
	assert.equal(t!.permission, 'readonly');
});
