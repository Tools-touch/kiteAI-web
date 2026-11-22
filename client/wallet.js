import { encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { getTypesForEIP712Domain, serializeTypedData } from 'viem';
import { KITE_WALLET, QUOTE_SECONDS, isWalletAddress, isWalletNonce, matchesWalletTerms, sameAddress } from '../shared/kite-wallet.js';

export const kiteChain = KITE_WALLET.chainId;
const clock = () => Math.floor(Date.now() / 1000);
const minimumRemaining = 8;

export async function readWallet(provider) {
  const [accounts, chain] = await Promise.all([
    provider.request({ method: 'eth_accounts' }),
    provider.request({ method: 'eth_chainId' })
  ]);
  const address = Array.isArray(accounts) && isWalletAddress(accounts[0])
    ? accounts[0] : undefined;
  const chainId = typeof chain === 'string' && /^0x[0-9a-f]+$/i.test(chain) ? Number(chain) : undefined;
  return { address, chainId: Number.isSafeInteger(chainId) ? chainId : undefined };
}

export async function connectWallet(provider) {
  await provider.request({ method: 'eth_requestAccounts' });
  return readWallet(provider);
}

export async function switchWalletChain(provider) {
  await provider.request({
    method: 'wallet_switchEthereumChain', params: [{ chainId: KITE_WALLET.chainHex }]
  });
  return readWallet(provider);
}

export function walletQuote({ challenge, header, service, address, path }, time = clock()) {
  const payment = service.payment;
  const [nonce, deadline, extra] = (header || '').split(':');
  const expiresAt = Number(deadline);
  if (!isWalletNonce(nonce) || extra !== undefined || !Number.isSafeInteger(expiresAt) ||
      expiresAt < time + minimumRemaining || expiresAt > time + QUOTE_SECONDS + 5) {
    throw new Error('Wallet quote expired or invalid. Request a new quote.');
  }
  const terms = challenge.accepts?.[0];
  if (challenge.x402Version !== 2 || !Array.isArray(challenge.accepts) || challenge.accepts.length !== 1 ||
      payment.mode !== KITE_WALLET.mode || payment.network !== KITE_WALLET.network ||
      payment.amount !== KITE_WALLET.amount || !sameAddress(payment.asset, KITE_WALLET.asset) ||
      !matchesWalletTerms(terms, payment.payTo) || !isWalletAddress(address) ||
      challenge.resource?.url !== service.endpoint) {
    throw new Error('Wallet quote differs from the configured chain, token, price, recipient, or resource.');
  }
  const resourceUrl = new URL(challenge.resource.url);
  if (resourceUrl.protocol !== 'https:' || resourceUrl.pathname !== path ||
      resourceUrl.search || resourceUrl.hash || resourceUrl.username || resourceUrl.password) {
    throw new Error('Wallet quote points to an unexpected resource.');
  }

  return Object.freeze({
    nonce, expiresAt, address, resource: Object.freeze({ ...challenge.resource }),
    terms: Object.freeze({ ...terms, extra: Object.freeze({ ...terms.extra }) })
  });
}

export async function signWalletQuote(provider, quote, isCurrent, now = clock) {
  function checkCurrent() {
    if (!isCurrent()) throw new Error('Wallet or request changed. Request a new quote.');
    if (quote.expiresAt < now() + minimumRemaining) {
      throw new Error('Wallet quote expired or is too close to expiry. Request a new quote.');
    }
  }

  async function checkWallet() {
    checkCurrent();
    const wallet = await readWallet(provider);
    checkCurrent();
    if (!sameAddress(wallet.address, quote.address)) throw new Error('Wallet account changed. Request a new quote.');
    if (wallet.chainId !== kiteChain) throw new Error('Switch your wallet to KiteAI Testnet before signing.');
  }

  await checkWallet();
  const scheme = new ExactEvmScheme({
    address: quote.address,
    async signTypedData(data) {
      checkCurrent();
      if (data.primaryType !== 'TransferWithAuthorization' ||
          data.domain.chainId !== kiteChain || data.domain.name !== KITE_WALLET.name ||
          data.domain.version !== KITE_WALLET.version || !sameAddress(data.domain.verifyingContract, KITE_WALLET.asset) ||
          !sameAddress(data.message.from, quote.address) || !sameAddress(data.message.to, quote.terms.payTo) ||
          data.message.value !== BigInt(quote.terms.amount) || data.message.validAfter !== 0n) {
        throw new Error('Unexpected x402 signing data.');
      }
      // The SDK supplies the EIP-3009 message. Use the server quote's nonce and absolute deadline.
      const message = { ...data.message, nonce: quote.nonce, validBefore: BigInt(quote.expiresAt) };
      const types = { ...data.types, EIP712Domain: getTypesForEIP712Domain({ domain: data.domain }) };
      const signature = await provider.request({
        method: 'eth_signTypedData_v4',
        params: [quote.address, serializeTypedData({ ...data, message, types })]
      });
      if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) {
        throw new Error('This wallet did not return a supported EVM signature.');
      }
      return signature;
    }
  });
  const result = await scheme.createPaymentPayload(2, quote.terms);
  await checkWallet();
  const authorization = {
    ...result.payload.authorization, nonce: quote.nonce, validBefore: String(quote.expiresAt)
  };
  return encodePaymentSignatureHeader({
    ...result, payload: { ...result.payload, authorization }, resource: quote.resource, accepted: quote.terms
  });
}
