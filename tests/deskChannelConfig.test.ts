import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeskChannelConfig } from '../src/core/deskChannelConfig.ts';

test('rejects model channel configuration before a desk turn can write floors', () => {
  assert.match(validateDeskChannelConfig({ ANTHROPIC_API_KEY: '' }) || '', /ANTHROPIC_API_KEY/);
  assert.match(validateDeskChannelConfig({ ANTHROPIC_API_KEY: undefined }) || '', /ANTHROPIC_API_KEY/);
  assert.equal(validateDeskChannelConfig({ ANTHROPIC_API_KEY: 'k' }), null);
});
