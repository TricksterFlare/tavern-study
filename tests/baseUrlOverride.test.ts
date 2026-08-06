import test from 'node:test';
import assert from 'node:assert/strict';
import { safeEndpoint } from '../src/adapters/streamModelBackends.ts';
import { completeText } from '../src/chat/modelBackend.ts';
import { AnthropicStreamBackend } from '../src/adapters/streamModelBackends.ts';

test('safeEndpoint accepts https and rejects http / embedded credentials / garbage', () => {
  assert.equal(safeEndpoint('https://gateway.example.com/v1/messages'), 'https://gateway.example.com/v1/messages');
  assert.equal(safeEndpoint('http://gateway.example.com/v1/messages'), null);
  assert.equal(safeEndpoint('https://user:pass@gateway.example.com/v1/messages'), null);
  assert.equal(safeEndpoint('not-a-url'), null);
});

test('completeText fails loudly on an invalid ANTHROPIC_BASE_URL instead of falling back', async () => {
  for (const bad of ['http://insecure.example.com/v1/messages', '']) {
    const r = await completeText(
      { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: bad },
      { system: 's', prompt: 'p', model: 'claude-sonnet-4-5' },
    );
    assert.equal(r.ok, false, `expected failure for ${JSON.stringify(bad)}`);
    if (!r.ok) assert.equal(r.kind, 'bad_base_url', `expected bad_base_url for ${JSON.stringify(bad)}`);
  }
});

test('AnthropicStreamBackend returns config failure on an invalid baseUrl without any network call', async () => {
  for (const bad of ['http://insecure.example.com/v1/messages', '']) {
    const backend = new AnthropicStreamBackend({ apiKey: 'k', baseUrl: bad });
    const r = await backend.streamChat({ model: 'claude-sonnet-4-5', system: [], prompt: 'p' } as any);
    assert.equal(r.ok, false, `expected failure for ${JSON.stringify(bad)}`);
    if (!r.ok) assert.equal((r as any).kind, 'config', `expected config for ${JSON.stringify(bad)}`);
  }
});
