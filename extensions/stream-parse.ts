/** @deprecated use extensions/harnesses/claude.ts parse directly */
export type { StreamedUsage, StreamedResult, ActivityEvent, StreamParseOutcome, ParseState, ParseOutcome } from './harnesses/types.ts';
import type { ParseState, StreamParseOutcome } from './harnesses/types.ts';
import { parseClaudeLine } from './harnesses/claude.ts';

export function parseStreamLines(lines: Iterable<string>): StreamParseOutcome {
	const state: ParseState = { streamedText: '', activities: [], result: null };
	let streamedText = '';
	const activities: StreamParseOutcome['activities'] = [];
	let result: StreamParseOutcome['result'] = null;
	for (const line of lines) {
		const out = parseClaudeLine(line, state);
		if (out.streamedText) {
			streamedText += out.streamedText;
			state.streamedText += out.streamedText;
		}
		if (out.activities) {
			for (const a of out.activities) {
				activities.push(a);
				state.activities.push(a);
			}
		}
		if (out.result) {
			result = out.result;
			state.result = out.result;
		}
	}
	return { streamedText, result, activities };
}
