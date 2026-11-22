import { isAddress } from 'viem';
import { createApp } from './app.js';
import { connectRegistry, localRegistry } from './registry.js';
import { paymentConfig } from './payments.js';

const env = process.env;
const mode = env.PAYMENT_MODE || 'local';
const payment = paymentConfig(mode, env);
let publicOrigin;
if (env.PUBLIC_ORIGIN) {
  const endpoint = new URL(env.PUBLIC_ORIGIN);
  if (endpoint.protocol !== 'https:' || !/^[a-z0-9.-]+$/i.test(endpoint.hostname) || ![endpoint.origin, endpoint.origin + '/'].includes(env.PUBLIC_ORIGIN)) {
    throw new Error('PUBLIC_ORIGIN must be a public HTTPS origin without path or credentials');
  }
  publicOrigin = endpoint.origin;
}
if (mode !== 'local' && !publicOrigin) throw new Error('PUBLIC_ORIGIN is required for official modes');

const port = Number(env.PORT || 4173);
const host = env.HOST || '127.0.0.1';
const external = env.REGISTRY_RPC_URL || env.REGISTRY_ADDRESS;
if (external && (!env.REGISTRY_RPC_URL || !env.REGISTRY_ADDRESS || !isAddress(env.REGISTRY_ADDRESS))) {
  throw new Error('Supply both REGISTRY_RPC_URL and a valid REGISTRY_ADDRESS');
}
const registry = external
  ? await connectRegistry(env.REGISTRY_RPC_URL, env.REGISTRY_ADDRESS)
  : await localRegistry(Number(env.ANVIL_PORT || 8547));

const server = createApp({ registry, payment, publicOrigin }).listen(port, host, () => {
  console.log('Kite Service Console at http://' + host + ':' + port + ' (' + mode + ')');
});
server.on('error', (error) => {
  registry.close?.();
  console.error(error.message);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close();
    registry.close?.();
  });
}
