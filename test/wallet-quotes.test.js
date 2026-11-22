import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { createApp } from '../server/app.js';
import { paymentConfig } from '../server/payments.js';
import { REPORT_PATH } from '../server/registry.js';

const payer = '0x' + '11'.repeat(20);
const merchant = '0x' + '22'.repeat(20);
const other = '0x' + '33'.repeat(20);
const key = 'ab'.repeat(32);
const publicOrigin = 'https://merchant.example';

async function fixture(t, mode = 'kite-testnet') {
  let time = 1_800_000_000;
  let version = '1';
  const counters = { verify: 0, settle: 0 };
  const payment = paymentConfig(mode, { PAY_TO: merchant });
  const facilitator = {
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: 'exact', network: payment.info.network }],
      extensions: [], signers: {}
    }),
    async verify() {
      counters.verify++;
      return { isValid: true, payer };
    },
    async settle() {
      counters.settle++;
      return { success: true, payer, network: payment.info.network, transaction: '0x' + 'cd'.repeat(32) };
    }
  };
  const registry = {
    read: async () => ({ enabled: true, name: 'Report', path: REPORT_PATH, version })
  };
  const app = createApp({ registry, payment, publicOrigin, facilitator, now: () => time });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'X-Console-Wallet': payer, 'X-Console-Run': key };

  return {
    counters, headers,
    request: custom => fetch(base + REPORT_PATH, { headers: custom }),
    readReceipt: () => fetch(base + '/api/runs/' + key),
    expire: () => { time += 60; },
    reconfigure: () => { version = '2'; },
    async quote() {
      const response = await fetch(base + REPORT_PATH, { headers });
      assert.equal(response.status, 402);
      const challenge = decodePaymentRequiredHeader(response.headers.get('Payment-Required'));
      const [nonce, expiresAt] = response.headers.get('X-Console-Quote').split(':');
      assert.equal(Number(expiresAt), time + 60);
      return {
        x402Version: 2, resource: challenge.resource, accepted: challenge.accepts[0],
        payload: {
          authorization: { from: payer, to: merchant, nonce, value: payment.info.amount, validAfter: '0', validBefore: expiresAt },
          signature: '0x' + '01'.repeat(65)
        }
      };
    },
    pay: (payload, custom = headers) => fetch(base + REPORT_PATH, {
      headers: { ...custom, 'Payment-Signature': encodePaymentSignatureHeader(payload) }
    })
  };
}

test('Kite wallet authorization is bound to request, account, service and approved terms', async t => {
  const app = await fixture(t);
  const quote = await app.quote();
  for (const [payload, headers, status] of [
    [quote, {}, 400],
    [quote, { ...app.headers, 'X-Console-Run': 'ac'.repeat(32) }, 410],
    [quote, { ...app.headers, 'X-Console-Wallet': other }, 400],
    [{ ...quote, resource: { url: publicOrigin + '/other' } }, app.headers, 400],
    ...[
      { network: 'eip155:8453' }, { asset: other }, { payTo: other }, { amount: '1' },
      { extra: { ...quote.accepted.extra, assetTransferMethod: 'permit2' } }
    ].map(accepted => [{ ...quote, accepted: { ...quote.accepted, ...accepted } }, app.headers, 400]),
    ...[{ from: other }, { to: other }, { value: '1' }, { validBefore: '1' }, { nonce: '0x' + '00'.repeat(32) }]
      .map(authorization => [{
        ...quote, payload: { ...quote.payload, authorization: { ...quote.payload.authorization, ...authorization } }
      }, app.headers, 400])
  ]) {
    const result = await app.pay(payload, headers);
    assert.equal(result.status, status);
    assert.equal(result.headers.has('Payment-Response'), false);
  }
  assert.deepEqual(app.counters, { verify: 0, settle: 0 });
  assert.equal((await app.readReceipt()).status, 404);

  const results = await Promise.all([app.pay(quote), app.pay(quote)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(decodePaymentResponseHeader(results.find(result => result.ok).headers.get('Payment-Response')).payer, payer);
  assert.deepEqual((await (await app.readReceipt()).json()).receipt, {
    success: true, payer, network: 'eip155:2368', transaction: '0x' + 'cd'.repeat(32)
  });
  assert.deepEqual(app.counters, { verify: 1, settle: 1 });
  assert.equal((await app.pay(quote)).status, 409);
});

test('expired or reconfigured quotes stop before facilitator calls', async t => {
  const changed = await fixture(t);
  const previousVersion = await changed.quote();
  changed.reconfigure();
  assert.equal((await changed.pay(previousVersion)).status, 409);
  assert.deepEqual(changed.counters, { verify: 0, settle: 0 });

  const expired = await fixture(t);
  const stale = await expired.quote();
  expired.expire();
  assert.equal((await expired.pay(stale)).status, 410);
  assert.deepEqual(expired.counters, { verify: 0, settle: 0 });
});

test('wallet quote is opt-in and limited to the Kite Testnet profile', async t => {
  const kite = await fixture(t);
  const standard = await kite.request({});
  assert.equal(standard.status, 402);
  assert.equal(standard.headers.has('X-Console-Quote'), false);
  const passport = await fixture(t, 'passport');
  assert.equal((await passport.request(passport.headers)).status, 400);
  assert.equal((await passport.request({})).status, 402);
});
