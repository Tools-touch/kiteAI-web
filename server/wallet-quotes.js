import { randomBytes } from 'node:crypto';
import { KITE_WALLET, QUOTE_SECONDS, WALLET_NONCE_PREFIX, isWalletAddress, isWalletNonce, matchesWalletTerms, sameAddress } from '../shared/kite-wallet.js';

export function walletQuotes({ payment, resource, now = () => Math.floor(Date.now() / 1000) }) {
  const quotes = new Map();
  const error = (status, message) => ({ status, error: message });

  return {
    check({ key, wallet, payload, version, hasQuery }) {
      const authorization = payload?.payload?.authorization;
      if (wallet === undefined && !isWalletNonce(authorization?.nonce)) return {};
      if (payment.mode !== KITE_WALLET.mode) return error(400, 'Wallet payments require Kite Testnet');
      if (hasQuery) return error(400, 'Wallet quotes are for a report request without query parameters');
      if (!key || !isWalletAddress(wallet)) {
        return error(400, 'Wallet address and request ID are required');
      }

      const time = now();
      for (const [id, quote] of quotes) {
        if (quote.expiresAt <= time) quotes.delete(id);
      }
      if (!payload) {
        if (quotes.has(key)) return error(409, 'Request a new wallet quote');
        if (quotes.size >= 1024) return error(503, 'Wallet quote capacity reached');
        const quote = {
          nonce: '0x' + WALLET_NONCE_PREFIX + randomBytes(24).toString('hex'),
          wallet, version, expiresAt: time + QUOTE_SECONDS, used: false
        };
        quotes.set(key, quote);
        return { header: quote.nonce + ':' + quote.expiresAt };
      }

      const quote = quotes.get(key);
      if (!quote) return error(410, 'Wallet quote expired or unavailable');
      if (quote.used) return error(409, 'This wallet quote already has a payment attempt');
      if (quote.version !== version) return error(409, 'Service changed. Request a new wallet quote');
      if (!sameAddress(wallet, quote.wallet) || !sameAddress(authorization?.from, quote.wallet) ||
          !sameAddress(authorization?.to, payment.payTo) || payload.x402Version !== 2 ||
          payload.resource?.url !== resource || !matchesWalletTerms(payload.accepted, payment.payTo) ||
          authorization?.nonce !== quote.nonce || authorization.value !== payment.amount ||
          authorization.validAfter !== '0' || authorization.validBefore !== String(quote.expiresAt)) {
        return error(400, 'Payment authorization does not match the wallet quote');
      }

      return { consume: () => { quote.used = true; } };
    }
  };
}
