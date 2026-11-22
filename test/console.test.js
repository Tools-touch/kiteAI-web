import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader,
  encodePaymentSignatureHeader, HTTPFacilitatorClient } from '@x402/core/http';
import { parseEventLogs, stringToHex, zeroHash } from 'viem';
import express from 'express';
import { createApp } from '../server/app.js';
import { paymentConfig } from '../server/payments.js';
import { localRegistry, registryArtifact, REPORT_NAME, REPORT_PATH, SERVICE_ID } from '../server/registry.js';

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

async function openPort() {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}

const reportHeaders = signature => ({ 'Payment-Signature': signature });
const localPayment = paymentConfig('local', {});

test('Anvil registry and local HTTP lifecycle', async t => {
  const registry = await localRegistry(await openPort());
  t.after(registry.close);
  const { abi } = registryArtifact();
  const base = await listen(t, createApp({ registry, payment: localPayment }));
  const get = (path, options) => fetch(base + path, options);
  const authorize = async () => {
    const result = await get('/api/demo/authorize', { method: 'POST' });
    assert.equal(result.status, 200);
    return (await result.json()).paymentSignature;
  };

  await t.test('registry owner, independent service IDs, validation and event version', async () => {
    assert.equal(await registry.client.readContract({ address: registry.address, abi, functionName: 'owner' }), registry.owner);
    const secondId = stringToHex('second service', { size: 32 });
    const receipt = await registry.configure(secondId, 'Second service', '/api/next', true);
    const [event] = parseEventLogs({ abi, logs: receipt.logs, eventName: 'ServiceConfigured' });
    assert.deepEqual(event.args, { id: secondId, version: 1n, enabled: true, name: 'Second service', path: '/api/next' });
    assert.equal((await registry.read()).version, '1');
    await assert.rejects(registry.configure(SERVICE_ID, REPORT_NAME, REPORT_PATH, false, registry.other), /Unauthorized/);
    await assert.rejects(registry.configure(zeroHash, REPORT_NAME, REPORT_PATH, true), /InvalidService/);
    await assert.rejects(registry.configure(SERVICE_ID, '', REPORT_PATH, true), /InvalidService/);
    await assert.rejects(registry.configure(SERVICE_ID, REPORT_NAME, '//outside.example', true), /InvalidService/);
    assert.equal((await registry.read()).enabled, true);
  });

  await t.test('six direct routes and no ambiguous paid methods', async () => {
    for (const path of ['/', '/services', '/services/status-report', '/requests', '/passport', '/registry']) {
      const page = await get(path);
      assert.equal(page.status, 200, path);
      assert.match(await page.text(), /<main/);
    }
    assert.equal((await get('/services/unknown')).status, 404);
    assert.equal((await get(REPORT_PATH, { method: 'HEAD' })).status, 405);
    assert.equal((await get('/API/report')).status, 404);
    assert.equal((await get(REPORT_PATH + '/')).status, 404);
  });

  await t.test('missing, malformed, mismatched and tampered authorizations', async () => {
    const challenge = await get(REPORT_PATH);
    assert.equal(challenge.status, 402);
    const decoded = decodePaymentRequiredHeader(challenge.headers.get('payment-required'));
    assert.equal(decoded.x402Version, 2);
    assert.deepEqual(decoded.accepts, [localPayment.requirements]);
    assert.equal(challenge.headers.has('payment-response'), false);
    const signature = await authorize();
    const payload = decodePaymentSignatureHeader(signature);
    const wrongTerms = { ...payload, accepted: { ...payload.accepted, amount: '1' } };
    const tampered = { ...payload, payload: { ...payload.payload, expires: 0 } };
    for (const invalid of ['garbage', encodePaymentSignatureHeader(wrongTerms), encodePaymentSignatureHeader(tampered)]) {
      const rejected = await get(REPORT_PATH, { headers: reportHeaders(invalid) });
      assert.equal(rejected.status, 402);
      assert.equal(rejected.headers.has('payment-response'), false);
      assert.equal((await rejected.json()).report, undefined);
    }
  });

  await t.test('one settlement with concurrent replay, report digest and chain state', async () => {
    const signature = await authorize();
    const results = await Promise.all(Array.from({ length: 4 }, () => get(REPORT_PATH, { headers: reportHeaders(signature) })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 402, 402, 402]);
    const result = results.find(item => item.ok);
    const receipt = decodePaymentResponseHeader(result.headers.get('payment-response'));
    assert.equal(receipt.success, true);
    assert.equal(receipt.network, 'eip155:31337');
    assert.match(receipt.transaction, /^demo-[a-f0-9]{64}$/);
    const body = await result.json();
    assert.equal(body.mode, 'local');
    assert.deepEqual(body.report.registry, await registry.read());
    assert.equal(body.sha256, createHash('sha256').update(JSON.stringify(body.report)).digest('hex'));
  });

  await t.test('disable and re-enable immediately affect HTTP and increase version', async () => {
    const signature = await authorize();
    await registry.configure(SERVICE_ID, REPORT_NAME, REPORT_PATH, false);
    const unavailable = await get(REPORT_PATH, { headers: reportHeaders(signature) });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.has('payment-response'), false);
    const disabled = await (await get('/api/service')).json();
    assert.equal(disabled.available, false);
    assert.equal(disabled.registry.version, '2');
    await registry.configure(SERVICE_ID, REPORT_NAME, REPORT_PATH, true);
    const enabled = await (await get('/api/service')).json();
    assert.equal(enabled.available, true);
    assert.equal(enabled.registry.version, '3');
    assert.equal((await get(REPORT_PATH)).status, 402);
  });
});

test('official HTTP facilitator contract and failure handling without a paid request', async t => {
  const counters = { verify: 0, settle: 0 };
  const payment = paymentConfig('passport', { PAY_TO: '0x0000000000000000000000000000000000000002' });
  const { requirements } = payment;
  const hash = '0x' + 'ab'.repeat(32);
  let failure;
  const upstream = express().use(express.json());
  upstream.get('/v2/supported', (_req, res) => res.json({
    kinds: [{ x402Version: 2, scheme: 'exact', network: requirements.network }], extensions: [], signers: {}
  }));
  upstream.post('/v2/verify', (req, res) => {
    counters.verify++;
    assert.deepEqual(req.body.paymentRequirements, requirements);
    assert.equal(req.body.paymentPayload.x402Version, 2);
    res.json(failure === 'verify' ? { isValid: false, invalidReason: 'fixture_rejected' } : { isValid: true });
  });
  upstream.post('/v2/settle', (_req, res) => {
    counters.settle++;
    res.json({ success: failure !== 'settle', errorReason: failure === 'settle' ? 'fixture_rejected' : undefined, network: requirements.network, transaction: hash });
  });
  const facilitator = new HTTPFacilitatorClient({ url: await listen(t, upstream) + '/v2' });
  let reads = 0;
  const service = { id: SERVICE_ID, name: REPORT_NAME, path: REPORT_PATH, enabled: true, version: '1' };
  const registry = { read: async () => {
    if (failure === 'rpc') throw new Error('RPC down');
    reads++;
    return failure === 'changed' && reads === 2 ? { ...service, version: '2' } : service;
  } };
  const publicOrigin = 'https://merchant.example';
  const base = await listen(t, createApp({
    registry, payment, facilitator, publicOrigin,
    report: async () => {
      if (failure === 'report') throw new Error('Report failed');
      return { status: 'operational' };
    }
  }));
  const key = '47'.repeat(32);
  const check = () => fetch(base + '/api/runs/' + key);
  const signature = encodePaymentSignatureHeader({
    x402Version: 2, accepted: requirements, payload: { fixture: true }
  });
  const submit = () => fetch(base + REPORT_PATH, {
    headers: { ...reportHeaders(signature), 'X-Console-Run': key }
  });

  const challenge = await fetch(base + REPORT_PATH);
  assert.equal(challenge.status, 402);
  assert.equal(decodePaymentRequiredHeader(challenge.headers.get('payment-required')).resource.url, publicOrigin + REPORT_PATH);
  assert.equal((await fetch(base + '/api/demo/authorize', { method: 'POST' })).status, 404);
  assert.deepEqual(await (await fetch(base + '/api/integration')).json(), {
    mode: 'passport', supported: true, sessionVerified: false
  });

  for (const [reason, status] of [['rpc', 503], ['verify', 402], ['report', 502], ['changed', 503], ['settle', 402]]) {
    failure = reason;
    reads = 0;
    const before = { ...counters };
    const response = await submit();
    assert.equal(response.status, status, reason);
    assert.equal((await response.json()).report, undefined);
    assert.equal(counters.verify - before.verify, reason === 'rpc' ? 0 : 1);
    assert.equal(counters.settle - before.settle, reason === 'settle' ? 1 : 0);
    assert.equal((await check()).status, 404);
  }

  failure = undefined;
  const success = await submit();
  assert.equal(success.status, 200);
  const result = await (await check()).json();
  assert.deepEqual(result.report, { status: 'operational' });
  assert.equal(result.receipt.transaction, hash);
  assert.equal(result.mode, 'passport');
  const beforeReplay = { ...counters };
  assert.equal((await submit()).status, 409);
  assert.deepEqual(counters, beforeReplay);
  assert.equal((await fetch(base + '/api/runs/' + '00'.repeat(32))).status, 404);
});

test('all payment profiles use integer amounts and enforce merchant address', () => {
  assert.throws(() => paymentConfig('passport', {}), /PAY_TO/);
  assert.throws(() => paymentConfig('kite-testnet', { PAY_TO: '0x' + '0'.repeat(40) }), /PAY_TO/);
  const env = { PAY_TO: '0x0000000000000000000000000000000000000002' };
  const kite = paymentConfig('kite-testnet', env);
  assert.equal(kite.requirements.amount, '10000000000000000');
  assert.deepEqual(kite.requirements.extra, { name: 'pieUSD', version: '1' });
  assert.equal(paymentConfig('passport', env).requirements.amount, '10000');
});
