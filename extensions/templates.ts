import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedPermission } from './harnesses/types.ts';

export type PermissionMode = 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'auto' | 'manual';

const PERMISSION_MODES = new Set<PermissionMode>([
	'plan',
	'acceptEdits',
	'bypassPermissions',
	'dontAsk',
	'auto',
	'manual',
]);

export interface DelegateTemplate {
	name: string;
	description: string;
	permission: NormalizedPermission;
	/** Native harness permission string if user used escape hatch. */
	nativePermission?: string;
	/** Legacy raw permissionMode for transcript compat. */
	permissionMode: PermissionMode;
	model?: string;
	maxBudgetUsd?: number;
	skill?: string;
	defaultTask?: string;
	defaultScope?: string;
	prompt: string;
	harness?: string;
}

export function normalizePermission(
	raw: string | undefined,
	fallbackMode: string | undefined,
): { permission: NormalizedPermission; nativePermission?: string; permissionMode: PermissionMode } {
	// Prefer normalized permission
	if (raw) {
		const lower = raw.trim().toLowerCase();
		if (lower === 'readonly' || lower === 'read-only' || lower === 'read_only')
			return { permission: 'readonly', permissionMode: 'plan' };
		if (lower === 'edit' || lower === 'acceptEdits' || lower === 'accept-edits')
			return { permission: 'edit', permissionMode: 'acceptEdits' };
		if (
			lower === 'danger' ||
			lower === 'bypassPermissions' ||
			lower === 'danger-full-access' ||
			lower === 'danger_full_access'
		)
			return { permission: 'danger', permissionMode: 'bypassPermissions' };
		// Unknown native — treat as native escape hatch
		return { permission: 'edit', nativePermission: raw.trim(), permissionMode: 'acceptEdits' };
	}
	// Legacy permissionMode mapping
	if (fallbackMode && PERMISSION_MODES.has(fallbackMode as PermissionMode)) {
		const m = fallbackMode as PermissionMode;
		if (m === 'plan') return { permission: 'readonly', permissionMode: m };
		if (m === 'bypassPermissions') return { permission: 'danger', permissionMode: m };
		return { permission: 'edit', permissionMode: m };
	}
	return { permission: 'edit', permissionMode: 'acceptEdits' };
}

/** Parse a template file: frontmatter (---\nkey: value\n---) + markdown body. */
export function parseTemplate(text: string): DelegateTemplate | null {
	const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.trimStart());
	if (!m) return null;

	const meta: Record<string, string> = {};
	for (const line of m[1].split('\n')) {
		const i = line.indexOf(':');
		if (i <= 0) continue;
		meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}

	const name = meta.name?.trim();
	if (!name) return null;

	const permRaw = meta.permission?.trim();
	const permModeRaw = meta.permissionMode?.trim() ?? meta.sandbox?.trim();
	const norm = normalizePermission(permRaw, permModeRaw);

	const budget = meta.maxBudgetUsd ? Number(meta.maxBudgetUsd) : NaN;

	return {
		name,
		description: meta.description ?? '',
		permission: norm.permission,
		nativePermission: norm.nativePermission,
		permissionMode: norm.permissionMode,
		model: meta.model || undefined,
		maxBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : undefined,
		skill: meta.skill || undefined,
		defaultTask: meta.defaultTask || undefined,
		defaultScope: meta.defaultScope || undefined,
		prompt: m[2].trim(),
		harness: meta.harness || undefined,
	};
}

function loadDir(dir: string, out: Map<string, DelegateTemplate>): void {
	if (!existsSync(dir)) return;
	for (const f of readdirSync(dir)) {
		if (!f.endsWith('.md')) continue;
		try {
			const t = parseTemplate(readFileSync(join(dir, f), 'utf8'));
			if (t) out.set(t.name, t);
		} catch {
			// skip unreadable files
		}
	}
}

export function builtinTemplatesDir(): string {
	return fileURLToPath(new URL('../templates/', import.meta.url));
}

export function builtinHarnessTemplatesDir(harness: string): string {
	return fileURLToPath(new URL(`../templates/${harness}/`, import.meta.url));
}

export function sharedTemplatesDir(): string {
	return fileURLToPath(new URL('../templates/shared/', import.meta.url));
}

export function userTemplatesDir(harness?: string): string {
	const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
	if (harness) return join(dir, 'delegate', 'templates', harness);
	return join(dir, 'delegate', 'templates');
}

export function projectTemplatesDir(cwd: string, harness?: string): string {
	if (harness) return join(cwd, '.pi', 'delegate', 'templates', harness);
	return join(cwd, '.pi', 'delegate', 'templates');
}

/** Legacy dirs for compat */
function legacyUserTemplatesDir(): string {
	const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
	return join(dir, 'claude-delegate', 'templates');
}
function legacyProjectTemplatesDir(cwd: string): string {
	return join(cwd, '.pi', 'claude-delegate', 'templates');
}

/** Legacy root < shared < harness builtins < legacyUser < user < user/harness < legacyProject < project < project/harness (later wins). */
export function loadTemplates(cwd: string, harnessName?: string): Map<string, DelegateTemplate> {
	const out = new Map<string, DelegateTemplate>();
	const harness = harnessName ?? 'claude';
	// legacy root builtins (templates/*.md) lowest — for migration from pi-claude-delegate
	loadDir(builtinTemplatesDir(), out);
	// shared canonical bodies
	loadDir(sharedTemplatesDir(), out);
	// harness-specific builtins override shared
	loadDir(builtinHarnessTemplatesDir(harness), out);
	// user globals: legacy before new so new wins
	loadDir(legacyUserTemplatesDir(), out);
	loadDir(userTemplatesDir(), out);
	loadDir(userTemplatesDir(harness), out);
	// project locals: legacy before new so new wins
	loadDir(legacyProjectTemplatesDir(cwd), out);
	loadDir(projectTemplatesDir(cwd), out);
	loadDir(projectTemplatesDir(cwd, harness), out);
	return out;
}

export function loadAllTemplates(cwd: string): Map<string, DelegateTemplate> {
	return loadTemplates(cwd);
}
