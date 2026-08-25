import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStreamLines } from "../extensions/stream-parse.ts";

test("extracts text deltas and the final result", () => {
	const lines = [
		JSON.stringify({ type: "system", subtype: "init" }),
		JSON.stringify({
			type: "stream_event",
			event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
		}),
		JSON.stringify({
			type: "stream_event",
			event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
		}),
		JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }),
		JSON.stringify({
			type: "result",
			result: "Hello",
			num_turns: 1,
			total_cost_usd: 0.01,
			session_id: "abc",
			duration_ms: 2500,
			ttft_ms: 400,
			modelUsage: { "claude-sonnet-5": { contextWindow: 1000000, maxOutputTokens: 64000 } },
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				cache_creation_input_tokens: 2,
				cache_read_input_tokens: 3,
			},
		}),
	];

	const { streamedText, result } = parseStreamLines(lines);
	assert.equal(streamedText, "Hello");
	assert.ok(result);
	assert.equal(result!.result, "Hello");
	assert.equal(result!.totalCostUsd, 0.01);
	assert.equal(result!.usage!.inputTokens, 1);
	assert.equal(result!.durationMs, 2500);
	assert.equal(result!.ttftMs, 400);
	assert.equal(result!.model, "claude-sonnet-5");
	assert.equal(result!.contextWindow, 1_000_000);
	assert.equal(result!.maxOutputTokens, 64000);
});

test("handles malformed lines gracefully", () => {
	const { streamedText, result, activities } = parseStreamLines(["not json", "", "{}", "null"]);
	assert.equal(streamedText, "");
	assert.equal(result, null);
	assert.deepEqual(activities, []);
});

test("extracts tool activity from the stream", () => {
	const lines = [
		JSON.stringify({
			type: "stream_event",
			event: {
				type: "content_block_start",
				content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} },
			},
		}),
		JSON.stringify({
			type: "assistant",
			message: {
				content: [
					{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls", description: "List files" } },
				],
			},
		}),
		JSON.stringify({
			type: "user",
			message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts\nb.ts", is_error: false }] },
		}),
		JSON.stringify({
			type: "stream_event",
			event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
		}),
	];
	const { activities } = parseStreamLines(lines);
	assert.deepEqual(activities, [
		{ kind: "tool_start", name: "Bash" },
		{ kind: "tool_input", name: "Bash", input: { command: "ls", description: "List files" } },
		{ kind: "tool_result", isError: false },
		{ kind: "thinking", chars: 3 },
	]);
});
