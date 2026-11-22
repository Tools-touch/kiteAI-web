export const KITE_WALLET = Object.freeze({
  mode: 'kite-testnet',
  network: 'eip155:2368',
  chainId: 2368,
  chainHex: '0x940',
  symbol: 'pieUSD',
  asset: '0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A',
  decimals: 18,
  amount: '10000000000000000',
  name: 'pieUSD',
  version: '1',
  explorer: 'https://testnet.kitescan.ai/tx/'
});

export const WALLET_NONCE_PREFIX = '6b69746577616c31';
export const QUOTE_SECONDS = 60;

export function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' &&
    /^0x[0-9a-f]{40}$/i.test(a) && /^0x[0-9a-f]{40}$/i.test(b) &&
    a.toLowerCase() === b.toLowerCase();
}

export function isWalletNonce(value) {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) &&
    value.toLowerCase().startsWith('0x' + WALLET_NONCE_PREFIX);
}

export function matchesWalletTerms(terms, payTo) {
  const extra = terms?.extra;
  return terms?.scheme === 'exact' && terms.network === KITE_WALLET.network &&
    sameAddress(terms.asset, KITE_WALLET.asset) && sameAddress(terms.payTo, payTo) &&
    terms.amount === KITE_WALLET.amount && terms.maxTimeoutSeconds === QUOTE_SECONDS &&
    extra?.name === KITE_WALLET.name && extra.version === KITE_WALLET.version &&
    (extra.assetTransferMethod === undefined || extra.assetTransferMethod === 'eip3009');
}
