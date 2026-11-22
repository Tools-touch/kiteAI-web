const byId = id => document.getElementById(id);

export function walletPanel(onChange, onError) {
  let api;
  let provider;
  let state = {};
  let loading = false;
  let revision = 0;
  let locked = false;
  const connect = byId('wallet-connect');
  const switchChain = byId('wallet-switch');

  function render() {
    byId('wallet-address').textContent = state.address || 'Disconnected';
    byId('wallet-network').textContent = state.chainId !== undefined && state.chainId === api?.kiteChain
      ? 'KiteAI Testnet · ' + state.chainId
      : state.chainId ? 'Chain ' + state.chainId : '—';
    connect.textContent = loading ? 'Checking wallet…' : state.address ? 'Wallet connected' : 'Connect wallet';
    connect.disabled = locked || loading || Boolean(state.address);
    switchChain.hidden = !state.address || state.chainId === api?.kiteChain;
    switchChain.disabled = locked || loading;
  }

  async function refresh(read) {
    const current = ++revision;
    try {
      const next = await read();
      if (current === revision) state = next;
    } catch (error) {
      if (current !== revision) return;
      state = {};
      throw error;
    } finally {
      render();
      onChange(false);
    }
  }

  function changed() {
    state = {};
    onChange();
    render();
    refresh(() => api.readWallet(provider)).catch(() => onError('Could not read wallet status.'));
  }

  async function interact(operation) {
    if (loading || locked) return;
    loading = true;
    render();
    try {
      if (!provider) {
        const injected = window.ethereum;
        if (typeof injected?.request !== 'function' || typeof injected.on !== 'function') {
          throw new Error('An injected EVM wallet is required for browser payments.');
        }
        api = await import('/assets/wallet.js');
        provider = injected;
        provider.on('accountsChanged', changed);
        provider.on('chainChanged', changed);
        provider.on('disconnect', () => {
          revision++;
          state = {};
          onChange();
          render();
        });
      }
      onError('');
      await refresh(() => operation(api, provider));
    } catch (error) {
      onError(error.code === 4001 ? 'Wallet request declined.' : error.code === 4902
        ? 'Add KiteAI Testnet (chain 2368) in your wallet, then switch to it.'
        : error.message);
    } finally {
      loading = false;
      render();
      onChange(false);
    }
  }

  connect.addEventListener('click', () => interact((client, wallet) => client.connectWallet(wallet)));
  switchChain.addEventListener('click', () => interact((client, wallet) => client.switchWalletChain(wallet)));

  return {
    ready: () => Boolean(state.address) && state.chainId === api?.kiteChain && !loading,
    address: () => state.address,
    makeQuote: input => api.walletQuote({ ...input, address: state.address }),
    sign: (quote, isCurrent) => api.signWalletQuote(provider, quote, isCurrent),
    lock(value) {
      locked = value;
      render();
    }
  };
}
