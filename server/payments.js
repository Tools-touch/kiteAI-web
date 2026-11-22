import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { isAddress, zeroAddress } from 'viem';

export const OFFICIAL_FACILITATOR = 'https://facilitator.pieverse.io/v2';

const profiles = {
  local: { network: 'eip155:31337', symbol: 'demoUSD', asset: '0x0000000000000000000000000000000000000001', decimals: 6, name: 'Local demo USD', version: '1' },
  passport: { network: 'eip155:8453', symbol: 'USDC', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, name: 'USD Coin', version: '2', explorer: 'https://basescan.org/tx/' },
  'kite-testnet': { network: 'eip155:2368', symbol: 'pieUSD', asset: '0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A', decimals: 18, name: 'pieUSD', version: '1', explorer: 'https://testnet.kitescan.ai/tx/' }
};

export function paymentConfig(mode, env) {
  if (!Object.hasOwn(profiles, mode)) throw new Error('PAYMENT_MODE must be local, passport or kite-testnet');
  const profile = profiles[mode];
  const payTo = mode === 'local' ? '0x0000000000000000000000000000000000000002' : env.PAY_TO;
  if (!payTo || !isAddress(payTo) || payTo === zeroAddress) throw new Error('PAY_TO must be a nonzero EVM address');
  const { network, asset, symbol, explorer, decimals, name, version } = profile;
  const amount = (10n ** BigInt(decimals - 2)).toString();
  const extra = { name, version };
  const requirements = { scheme: 'exact', network, amount, asset, payTo, extra, maxTimeoutSeconds: 60 };
  return {
    requirements,
    price: { amount, asset, extra },
    info: { mode, network, symbol, asset, payTo, amount, displayPrice: '0.01 ' + symbol, explorer },
    facilitator: mode === 'local' ? undefined : new HTTPFacilitatorClient({
      url: OFFICIAL_FACILITATOR, timeoutMs: 20_000
    })
  };
}

/** Local-only facilitator. It signs short-lived demo authorizations and performs no token transfers. */
export function localFacilitator(requirements) {
  const key = randomBytes(32);
  const spent = new Map();
  const payer = '0x0000000000000000000000000000000000000003';
  const mac = (nonce, expires, terms) => createHmac('sha256', key)
    .update(JSON.stringify([nonce, expires, terms.scheme, terms.network, terms.amount, terms.asset, terms.payTo]))
    .digest();

  function verify(payment, terms) {
    const { nonce, expires, signature } = payment.payload ?? {};
    const now = Date.now();
    for (const [id, expiry] of spent) {
      if (expiry <= now) spent.delete(id);
    }
    if (typeof nonce !== 'string' || !Number.isSafeInteger(expires) || expires <= now ||
        expires > now + 60_000 || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature) ||
        !timingSafeEqual(mac(nonce, expires, terms), Buffer.from(signature, 'hex'))) {
      return { isValid: false, invalidReason: 'invalid_demo_authorization' };
    }
    if (spent.has(nonce)) return { isValid: false, invalidReason: 'demo_authorization_already_used' };
    return { isValid: true, payer };
  }

  return {
    authorize(resource) {
      const nonce = randomUUID();
      const expires = Date.now() + 60_000;
      return {
        x402Version: 2, resource, accepted: requirements,
        payload: { nonce, expires, signature: mac(nonce, expires, requirements).toString('hex') }
      };
    },
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: 'exact', network: requirements.network }], extensions: [], signers: {} };
    },
    async verify(payment, terms) {
      return verify(payment, terms);
    },
    async settle(payment, terms) {
      const result = verify(payment, terms);
      if (!result.isValid || spent.size >= 4096) {
        return { success: false, errorReason: result.invalidReason ?? 'demo_capacity_reached', network: terms.network, transaction: '' };
      }
      const { nonce, expires } = payment.payload;
      spent.set(nonce, expires);
      const transaction = 'demo-' + createHash('sha256').update(nonce).digest('hex');
      return { success: true, transaction, network: terms.network, payer };
    }
  };
}
