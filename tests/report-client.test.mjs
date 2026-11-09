import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ReportClient, prepareDraft, validatePhoto, ReportApiError } from '../integration/report-client.mjs';

// These are transport-contract fixtures, not production reports or real agency cases.
const input = { category: 'pothole', description: 'Test fixture only', latitude: 25.7, longitude: -80.3 };
const png = () => new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGbsAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function harness(fn = () => json({ ok: true })) {
  const calls = [];
  const client = new ReportClient({ baseUrl: 'https://loop.test', timeoutMs: 200,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return fn(url, options, calls.length); } });
  return { client, calls };
}

test('preparing a draft freezes a separate snapshot and a stable request ID', () => {
  const original = { ...input, nested: { label: 'before' } };
  const draft = prepareDraft(original, 'request-test-001');
  original.nested.label = 'after';
  assert.equal(draft.input.nested.label, 'before');
  assert.throws(() => { draft.input.description = 'tampered'; }, TypeError);
  assert.equal(draft.request_id, 'request-test-001');
});

test('non-JSON values and excessively large descriptions are rejected', () => {
  for (const value of [NaN, Infinity, undefined, () => {}, 1n]) {
    assert.throws(() => prepareDraft({ ...input, value }), { code: 'INVALID_INPUT' });
  }
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => prepareDraft(cyclic), { code: 'INVALID_INPUT' });
  assert.throws(() => prepareDraft({ description: 'x'.repeat(40000) }), { code: 'INVALID_INPUT' });
});

test('saving requires location confirmation and an existing request ID', async () => {
  const { client, calls } = harness();
  assert.throws(() => client.saveDraft(prepareDraft(input)), { code: 'INVALID_INPUT' });
  assert.throws(() => client.saveDraft({ input }, { locationConfirmed: true }), { code: 'INVALID_INPUT' });
  assert.equal(calls.length, 0);
});

test('retries use the exact original idempotency payload', async () => {
  const { client, calls } = harness((_u, _o, count) => { if (count === 1) throw new Error('connection lost'); return json({ saved: true }); });
  const draft = prepareDraft(input, 'request-test-002');
  await assert.rejects(client.saveDraft(draft, { locationConfirmed: true }), { code: 'NETWORK_ERROR', uncertain: true });
  assert.equal(calls.length, 1, 'There must be no automatic POST replay');
  await client.saveDraft(draft, { locationConfirmed: true });
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.redirect, 'error');
});

test('approval requires explicit consent and never calls a submit endpoint', async () => {
  const { client, calls } = harness();
  assert.throws(() => client.approveHandoff('report_1', 2), { code: 'INVALID_INPUT' });
  assert.throws(() => client.approveHandoff('report_1', 2, { consent: 'true' }), { code: 'INVALID_INPUT' });
  await client.approveHandoff('report_1', 2, { consent: true });
  assert.deepEqual(JSON.parse(calls[0].options.body), { version: 2, consent: true });
  assert.equal(calls[0].url, 'https://loop.test/api/reports/report_1/approve');
  assert.equal(typeof client.submit, 'undefined');
});

test('stale versions are surfaced as conflicts without automatic retries', async () => {
  const { client, calls } = harness(() => json({ error: 'Refresh this report before continuing.' }, 409));
  await assert.rejects(client.editReport('report_1', input, 1, { locationConfirmed: true }), { code: 'CONFLICT', status: 409, uncertain: false });
  assert.equal(calls.length, 1);
});

test('missing authentication and rate limits have distinct errors', async () => {
  for (const [status, code] of [[401, 'SIGN_IN_REQUIRED'], [429, 'RATE_LIMITED']]) {
    const { client, calls } = harness(() => json({ error: 'Try later' }, status));
    await assert.rejects(client.listReports(), { code, status });
    assert.equal(calls.length, 1);
  }
});

test('server-side 5xx on a write means the result is uncertain', async () => {
  const { client, calls } = harness(() => json({ error: 'Temporary failure' }, 503));
  await assert.rejects(client.approveHandoff('report_1', 1, { consent: true }), { code: 'HTTP_ERROR', uncertain: true });
  assert.equal(calls.length, 1);
});

test('a login HTML page is not reported as a successful save', async () => {
  const { client } = harness(() => new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(client.saveDraft(prepareDraft(input), { locationConfirmed: true }), { code: 'INVALID_RESPONSE', uncertain: true });
});

test('unsafe origins, credentials in URLs and path injection are rejected', () => {
  for (const baseUrl of ['http://public.example', 'https://u:p@loop.test', 'https://loop.test/path', 'https://loop.test/?token=secret', 'file:///tmp']) {
    assert.throws(() => new ReportClient({ baseUrl }), { code: 'INVALID_INPUT' });
  }
  const { client } = harness();
  for (const id of ['../approve', 'a?b=c', 'a/b', '', '%2e%2e']) assert.throws(() => client.getReport(id), { code: 'INVALID_INPUT' });
  for (const version of [-1, NaN, '1', 1.5]) assert.throws(() => client.approveHandoff('report_1', version, { consent: true }), { code: 'INVALID_INPUT' });
});

test('photo validation requires a supported MIME type and matching signature', async () => {
  assert.equal((await validatePhoto(png())).extension, 'png');
  for (const file of [new Blob([], { type: 'image/png' }), new Blob(['not a photo'], { type: 'image/png' }),
    new Blob([await png().arrayBuffer()], { type: 'image/jpeg' }), new Blob([new Uint8Array(8 * 1024 * 1024 + 1)], { type: 'image/png' })]) {
    await assert.rejects(validatePhoto(file), { code: 'INVALID_INPUT' });
  }
});

test('photo upload sends multipart with version, without a hand-written boundary', async () => {
  const { client, calls } = harness();
  await client.uploadPhoto('report_1', png(), 4);
  const options = calls[0].options;
  assert.equal(options.headers['Content-Type'], undefined);
  assert.equal(options.body.get('version'), '4');
  assert.equal(options.body.get('photo').name, 'evidence.png');
  assert.equal(calls[0].url, 'https://loop.test/api/reports/report_1/photo');
});

test('invalid photo does not start a network request', async () => {
  const { client, calls } = harness();
  await assert.rejects(client.uploadPhoto('report_1', new Blob(['x'], { type: 'image/heic' }), 1));
  assert.equal(calls.length, 0);
});

test('a cancelled request is not sent', async () => {
  const { client, calls } = harness();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.listReports({ signal: controller.signal }), { code: 'CANCELLED', uncertain: false });
  assert.equal(calls.length, 0);
});

test('timeout cancels the transport and does not retry', async () => {
  let calls = 0;
  const client = new ReportClient({ baseUrl: 'https://loop.test', timeoutMs: 10,
    fetchImpl: (_url, { signal }) => { calls++; return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }); } });
  await assert.rejects(client.approveHandoff('report_1', 1, { consent: true }), { code: 'CANCELLED_OR_TIMED_OUT', uncertain: true });
  assert.equal(calls, 1);
});

test('packet retrieval does not imply submission or rewrite server status', async () => {
  const payload = { state: 'needs_user_action', agencyAccepted: false };
  const { client, calls } = harness(() => json(payload));
  assert.deepEqual(await client.getPacket('report_1'), payload);
  assert.equal(calls[0].options.method, 'GET');
  assert.throws(() => client.getPacket('report_1', { format: '../../submit' }), { code: 'INVALID_INPUT' });
});

test('plain text downloads reject HTML', async () => {
  const { client } = harness(() => new Response('Prepared, not submitted', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
  assert.equal(await client.getPacket('report_1', { format: 'text' }), 'Prepared, not submitted');
  const invalidClient = harness(() => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } })).client;
  await assert.rejects(invalidClient.getPacket('report_1', { format: 'text' }), { code: 'INVALID_RESPONSE' });
});

test('oversized and malformed JSON responses fail closed', async () => {
  for (const response of [new Response('{broken', { headers: { 'Content-Type': 'application/json' } }),
    new Response('x'.repeat(2*1024*1024+1), { headers: { 'Content-Type': 'application/json' } })]) {
    const { client } = harness(() => response);
    await assert.rejects(client.listReports(), ReportApiError);
  }
});

test('read methods cannot be converted into writes through options', async () => {
  const { client, calls } = harness();
  await client.capabilities({ method: 'POST', body: { dangerous: true } });
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
});

test('real local HTTP round trip: draft, photo, approve, packet; never submit', async (t) => {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    seen.push({ method: req.method, path: req.url, body, contentType: req.headers['content-type'] });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ fixtureOnly: true, version: seen.length }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const client = new ReportClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  const a = await client.saveDraft(prepareDraft(input, 'http-test-request-1'), { locationConfirmed: true });
  const b = await client.uploadPhoto('fixture_report', png(), a.version);
  await client.approveHandoff('fixture_report', b.version, { consent: true });
  await client.getPacket('fixture_report');
  assert.deepEqual(seen.map(r => r.method + ' ' + r.path), [
    'POST /api/reports', 'POST /api/reports/fixture_report/photo',
    'POST /api/reports/fixture_report/approve', 'GET /api/reports/fixture_report/packet']);
  assert.match(seen[1].contentType, /^multipart\/form-data; boundary=/);
  assert.match(seen[1].body, /name="photo"; filename="evidence.png"/);
  assert.equal(JSON.parse(seen[2].body).version, 2);
});
