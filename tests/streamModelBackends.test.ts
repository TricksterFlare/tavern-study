import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicStreamBackend } from '../src/adapters/streamModelBackends.ts';

const args = { system: [{ text: 'system', cache: true }], prompt: 'prompt', model: 'claude-sonnet-4-6' };

const fakeFetch = (body: string, status = 200, inspect?: (input: RequestInfo | URL, init?: RequestInit) => void) =>
  (async (input, init) => { inspect?.(input, init); return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } }); }) as typeof fetch;

test('anthropic accepts known terminal reasons and rejects stream errors', async () => {
  const clean = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}', '',
    'data: {"type":"message_stop"}', '',
  ].join('\n');
  {
    const result = await new AnthropicStreamBackend({ apiKey: 'key', fetch: fakeFetch(clean) }).streamChat(args);
    assert.equal(result.ok, true); if (result.ok) { assert.equal(result.stopReason, 'end_turn'); assert.equal(result.usage.output, 6); }
  }
  const truncated = clean.replace('data: {"type":"message_stop"}\n', '');
  const truncatedResult = await new AnthropicStreamBackend({ apiKey: 'key', fetch: fakeFetch(truncated) }).streamChat(args);
  assert.equal(truncatedResult.ok, false);
  const afterStop = `${clean}data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n`;
  const afterStopResult = await new AnthropicStreamBackend({ apiKey: 'key', fetch: fakeFetch(afterStop) }).streamChat(args);
  assert.equal(afterStopResult.ok, false);
  const broken = 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\ndata: {"type":"error"}\n';
  {
    const result = await new AnthropicStreamBackend({ apiKey: 'key', fetch: fakeFetch(broken) }).streamChat(args);
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.kind, 'protocol');
  }
});
