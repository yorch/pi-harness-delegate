/**
 * Delegation-intent detection for user input.
 *
 * Gated entirely by `autoDelegateHints` — when off, user input is never
 * touched and nothing nudges the agent toward this tool (the tool still
 * exists in the available-tools list, so the agent may still choose it).
 * When on:
 *   - Explicit markers: `@claude`, `@codex`, "…with claude/codex …"
 *     (marker stripped, hint appended)
 *   - Keyword phrasing: imperative review/plan/audit/docs (hint appended)
 *
 * Never hints when the text already names the tool or the /delegate command.
 */

export interface HintConfig {
	/** Master switch — false = no hinting at all. */
	autoDelegateHints: boolean;
}

const EXPLICIT_MARKER_RE =
	/(?:^|\s)@(?:claude|codex|opencode|amp)\b|(?:\b(with|via|using)\s+(?:claude|codex|opencode|amp|delegate)\b)|(?:\bdelegate\b[\s\S]*\b(?:claude|codex|opencode|amp|delegate)\b)/i;

const KEYWORD_RE = /^\s*(review|plan|audit|security\s*audit|document|implement|write\s+tests?)\b/i;

const HINT_TEXT =
	'[delegate] The user wants this delegated to a harness. ' +
	'Call the delegate tool with a fitting harness (claude, codex, opencode, amp) and mode (review, plan, security-audit, docs, implement, …) ' +
	'rather than doing the work yourself. Only skip it if delegation is clearly inappropriate.';

const LEGACY_HINT_TEXT =
	'[claude-delegate] The user wants this delegated to Claude Code. ' +
	'Call the claude_delegate tool with a fitting mode (review, plan, security-audit, docs, implement, …) ' +
	'rather than doing the work yourself. Only skip it if delegation is clearly inappropriate.';

export function delegationHint(text: string, cfg: HintConfig): string | null {
	if (!cfg.autoDelegateHints) return null;

	// already explicit about the tool or command — nothing to add
	if (/\bclaude_delegate\b|\/(?:claude|delegate|codex|opencode|amp)\b/.test(text)) return null;

	if (EXPLICIT_MARKER_RE.test(text)) return HINT_TEXT;

	if (KEYWORD_RE.test(text)) return HINT_TEXT;

	return null;
}

export function claudeDelegationHint(text: string, cfg: HintConfig): string | null {
	const h = delegationHint(text, cfg);
	if (h === HINT_TEXT) return LEGACY_HINT_TEXT;
	return h;
}

/** Remove the @harness prefix marker from the text before sending. */
export function stripMarker(text: string): string {
	return text.replace(/(?:^|\s)@(?:claude|codex|opencode|amp|delegate)\b/g, ' ').replace(/\s{2,}/g, ' ').trim();
}
