const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRealtimeGateway } = require('../electron/gateway');
const { connectionError } = require('../electron/connection-errors');
const { buildSessionConfig } = require('../electron/config');

test('an HTTP 401 produces one actionable failure with a request ID and no retries', async t => {
  const server = http.createServer((_req, res) => { res.writeHead(401, { 'x-request-id': 'request-test' }); res.end('unauthorized'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const failures = [];
  const gateway = createRealtimeGateway({ endpoint: 'ws://127.0.0.1:' + server.address().port, apiKey: 'secret-test-key', onFailure: error => failures.push(error) });
  t.after(() => gateway.close());
  await assert.rejects(gateway.connect(buildSessionConfig()), /API Key 验证失败/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].httpStatus, 401);
  assert.equal(failures[0].requestId, 'request-test');
  assert.equal(failures[0].retryable, false);
  assert.doesNotMatch(failures[0].message, /secret-test-key/);
});

test('network and server failures are retryable while authentication and limits are terminal', () => {
  for (const status of [401, 403, 404, 429]) assert.equal(connectionError({ status }).retryable, false);
  assert.equal(connectionError({ status: 503 }).retryable, true);
  assert.equal(connectionError().retryable, true);
  assert.equal(connectionError({ code: 'invalid_value', message: 'Invalid setting' }).retryable, false);
});
