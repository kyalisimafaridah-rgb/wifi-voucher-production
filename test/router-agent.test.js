import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentToken, hashAgentToken, buildRouterOSAgentScript } from '../src/services/router-agent.js';

test('agent tokens are strong and hash deterministically', () => {
  const token = createAgentToken();
  assert.ok(token.length >= 40);
  assert.equal(hashAgentToken(token), hashAgentToken(token));
  assert.notEqual(hashAgentToken(token), hashAgentToken(createAgentToken()));
});

test('RouterOS installer is persistent and scheduler-based', () => {
  const script = buildRouterOSAgentScript({
    server: 'https://example.test',
    token: 'test-token-123',
  });
  assert.match(script, /\/system script add/);
  assert.match(script, /\/system scheduler add/);
  assert.match(script, /interval=15s/);
  assert.match(script, /check-certificate=yes/);
  assert.match(script, /\/system script run/);
  assert.doesNotMatch(script, /:while \(true\)/);
});
