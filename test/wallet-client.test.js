import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import { verifyTypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { connectWallet, readWallet, signWalletQuote, switchWalletChain, walletQuote } from '../client/wallet.js';
import { createApp } from '../server/app.js';
import { paymentConfig } from '../server/payments.js';
import { KITE_WALLET, WALLET_NONCE_PREFIX } from '../shared/kite-wallet.js';

const account = privateKeyToAccount(generatePrivateKey());
const merchant = '0x' + '22'.repeat(20);
const payment = paymentConfig('kite-testnet', { PAY_TO: merchant });
const publicOrigin = 'https://merchant.example';
const path = '/api/report';
const service = { payment: payment.info, endpoint: publicOrigin + path };
const challenge = { x402Version: 2, resource: { url: service.endpoint }, accepts: [payment.requirements] };
const expiry = 1_800_000_060;
const nonce = '0x' + WALLET_NONCE_PREFIX + '11'.repeat(24);

function quote(options = {}, time = expiry - 60) {
  return walletQuote({
    challenge, header: nonce + ':' + expiry, service, address: account.address, path, ...options
  }, time);
}

function mockWallet() {
  let selected = account.address;
  let chain = '0x1';
  let connected = false;
  const methods = [];
  const messages = [];
  const state = { rejectSign: false, afterSign: () => {} };
  return {
    state, methods, messages,
    changeAccount: value => { selected = value; },
    changeChain: value => { chain = value; },
    async request({ method, params }) {
      methods.push(method);
      if (method === 'eth_requestAccounts') {
        connected = true;
        return [selected];
      }
      if (method === 'eth_accounts') return connected ? [selected] : [];
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_switchEthereumChain') {
        assert.deepEqual(params, [{ chainId: '0x940' }]);
        chain = params[0].chainId;
        return null;
      }
      assert.equal(method, 'eth_signTypedData_v4');
      assert.equal(params[0], account.address);
      if (state.rejectSign) throw Object.assign(new Error('Rejected'), { code: 4001 });
      const data = JSON.parse(params[1]);
      messages.push(data);
      const signature = await account.signTypedData(data);
      state.afterSign();
      return signature;
    }
  };
}

test('wallet connect and chain switch never request payment authorization', async () => {
  const wallet = mockWallet();
  assert.deepEqual(await readWallet(wallet), { address: undefined, chainId: 1 });
  assert.deepEqual(await connectWallet(wallet), { address: account.address, chainId: 1 });
  await assert.rejects(signWalletQuote(wallet, quote(), () => true, () => expiry - 60), /Switch your wallet/);
  assert.deepEqual(await switchWalletChain(wallet), { address: account.address, chainId: 2368 });
  assert.equal(wallet.methods.includes('eth_signTypedData_v4'), false);
  assert.equal(wallet.methods.includes('eth_sendTransaction'), false);
});

test('client rejects chain, asset, amount, recipient, domain, permit and resource changes in quotes', () => {
  const other = '0x' + '33'.repeat(20);
  for (const terms of [
    { network: 'eip155:8453' }, { asset: other }, { amount: '1' }, { payTo: other }, { maxTimeoutSeconds: 120 },
    { extra: { name: 'Fake pieUSD', version: '1' } },
    { extra: { ...payment.requirements.extra, assetTransferMethod: 'permit2' } }
  ]) {
    assert.throws(() => quote({ challenge: { ...challenge, accepts: [{ ...payment.requirements, ...terms }] } }), /differs/);
  }
  assert.throws(() => quote({ challenge: { ...challenge, resource: { url: 'https://other.example/api/report' } } }), /differs/);
  assert.throws(() => quote({ challenge: { x402Version: 2 } }), /differs/);
  assert.throws(() => quote({ header: nonce + ':' + (expiry + 120) }), /expired or invalid/);
  assert.throws(() => quote({}, expiry), /expired or invalid/);
});

test('rejection, expiry and wallet changes discard the signature', async () => {
  const wallet = mockWallet();
  await connectWallet(wallet);
  await switchWalletChain(wallet);
  const currentTime = () => expiry - 30;
  wallet.state.rejectSign = true;
  await assert.rejects(signWalletQuote(wallet, quote(), () => true, currentTime), { code: 4001 });
  wallet.state.rejectSign = false;

  let time = expiry - 30;
  wallet.state.afterSign = () => { time = expiry; };
  await assert.rejects(signWalletQuote(wallet, quote(), () => true, () => time), /expired/);
  wallet.state.afterSign = () => wallet.changeAccount(merchant);
  await assert.rejects(signWalletQuote(wallet, quote(), () => true, currentTime), /account changed/);
  wallet.changeAccount(account.address);
  wallet.state.afterSign = () => wallet.changeChain('0x1');
  await assert.rejects(signWalletQuote(wallet, quote(), () => true, currentTime), /Switch your wallet/);
  await switchWalletChain(wallet);
  let current = true;
  wallet.state.afterSign = () => { current = false; };
  await assert.rejects(signWalletQuote(wallet, quote(), () => current, currentTime), /changed/);
});

test('SDK Browser EIP-712 signature settles exactly one simulated request and produces a receipt', async t => {
  const tx = '0x' + 'cc'.repeat(32);
  const wallet = mockWallet();
  await connectWallet(wallet);
  await switchWalletChain(wallet);
  let settles = 0;
  const facilitator = {
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: 'exact', network: KITE_WALLET.network }], extensions: [], signers: {}
    }),
    async verify(payload, requirements) {
      assert.deepEqual(requirements, payment.requirements);
      const { signature, authorization } = payload.payload;
      const verified = await verifyTypedData({
        address: account.address, domain: { name: 'pieUSD', version: '1', chainId: 2368, verifyingContract: KITE_WALLET.asset },
        primaryType: 'TransferWithAuthorization', types: wallet.messages[0].types, message: authorization, signature
      });
      return { isValid: verified, payer: account.address };
    },
    async settle() {
      settles++;
      return { success: true, transaction: tx, network: KITE_WALLET.network, payer: account.address };
    }
  };
  const registry = { read: async () => ({ enabled: true, path, version: '1' }) };
  const app = createApp({ registry, payment, facilitator, publicOrigin });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const asset = await fetch(base + '/assets/wallet.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.match(await asset.text(), /eth_signTypedData_v4/);

  const key = 'ca'.repeat(32);
  const headers = { 'X-Console-Run': key, 'X-Console-Wallet': account.address };
  const get = () => fetch(base + path, { headers });
  const initial = await get();
  assert.equal(initial.status, 402);
  const header = initial.headers.get('X-Console-Quote');
  const liveQuote = walletQuote({
    challenge: decodePaymentRequiredHeader(initial.headers.get('Payment-Required')),
    header, service, address: account.address, path
  });
  const authorization = await signWalletQuote(wallet, liveQuote, () => true);
  const typedData = wallet.messages[0];
  const decoded = decodePaymentSignatureHeader(authorization);
  assert.equal(typedData.primaryType, 'TransferWithAuthorization');
  assert.deepEqual(typedData.domain, {
    name: 'pieUSD', version: '1', chainId: 2368, verifyingContract: KITE_WALLET.asset.toLowerCase()
  });
  assert.deepEqual(typedData.message, {
    ...decoded.payload.authorization, from: account.address.toLowerCase()
  });
  assert.equal(typedData.message.value, KITE_WALLET.amount);
  assert.equal(typedData.message.to, merchant);
  assert.equal(typedData.message.from, account.address.toLowerCase());
  assert.equal(typedData.message.validBefore, String(liveQuote.expiresAt));
  assert.equal(typedData.message.nonce, liveQuote.nonce);
  assert.equal(wallet.methods.filter(method => method === 'eth_signTypedData_v4').length, 1);
  headers['Payment-Signature'] = authorization;
  const results = await Promise.all([get(), get()]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  assert.equal(settles, 1);
  const receipt = decodePaymentResponseHeader(results.find(response => response.ok).headers.get('Payment-Response'));
  assert.equal(receipt.transaction, tx);
  assert.deepEqual((await (await fetch(base + '/api/runs/' + key)).json()).receipt, receipt);
});
