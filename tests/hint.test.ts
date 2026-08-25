import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delegationHint, stripMarker } from '../extensions/hint.ts';

const OFF = { autoDelegateHints: false };
const ON = { autoDelegateHints: true };

test('hints off: nothing hints, input untouched', () => {
	for (const t of [
		'@claude review the auth flow',
		'review the auth flow with claude',
		'delegate this to claude',
		'review the auth flow',
		'plan the cache migration',
	]) {
		assert.equal(delegationHint(t, OFF), null, t);
	}
});

test('hints on: explicit markers hint', () => {
	assert.ok(delegationHint('@claude review the auth flow', ON));
	assert.ok(delegationHint('review the auth flow with claude', ON));
	assert.ok(delegationHint('delegate this to claude', ON));
	assert.ok(delegationHint('plan the migration via claude', ON));
});

test('hints on: keyword phrasing hints', () => {
	assert.ok(delegationHint('review the auth flow', ON));
	assert.ok(delegationHint('plan the cache migration', ON));
	assert.ok(delegationHint('audit the auth package', ON));
	assert.ok(delegationHint('write tests for the parser', ON));
});

test('non-delegation phrasing never hints', () => {
	for (const t of ['explain the auth flow', 'what does review mean', 'summarize the repo', 'how does claude work']) {
		assert.equal(delegationHint(t, ON), null, t);
	}
});

test('already-explicit tool/command references are not re-hinted', () => {
	assert.equal(delegationHint('use claude_delegate to review', ON), null);
	assert.equal(delegationHint('/claude review the auth flow', ON), null);
});

test('stripMarker removes the @claude prefix', () => {
	assert.equal(stripMarker('@claude review the auth flow'), 'review the auth flow');
	assert.equal(stripMarker('review it @claude now'), 'review it now');
	assert.equal(stripMarker('no marker here'), 'no marker here');
});
