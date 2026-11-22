import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import solc from 'solc';
import { createPublicClient, createWalletClient, http, keccak256, stringToHex } from 'viem';

export const REPORT_PATH = '/api/report';
export const SERVICE_ID = keccak256(stringToHex('kite.service.status-report'));
export const REPORT_NAME = 'Service status report';

let compiled;
export function registryArtifact() {
  if (compiled) return compiled;
  const source = readFileSync(new URL('../contracts/ServiceRegistry.sol', import.meta.url), 'utf8');
  const result = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'ServiceRegistry.sol': { content: source } },
    settings: { evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
  })));
  const error = result.errors?.find(item => item.severity === 'error');
  if (error) throw new Error(error.formattedMessage);
  const contract = result.contracts['ServiceRegistry.sol'].ServiceRegistry;
  compiled = { abi: contract.abi, bytecode: '0x' + contract.evm.bytecode.object };
  return compiled;
}

export async function connectRegistry(rpc, address) {
  const client = createPublicClient({ transport: http(rpc, { timeout: 3500, retryCount: 0 }) });
  const [chainId, code] = await Promise.all([client.getChainId(), client.getCode({ address })]);
  if (!code) throw new Error('No contract at REGISTRY_ADDRESS');
  const { abi } = registryArtifact();
  return {
    async read() {
      const block = await client.getBlockNumber({ cacheTime: 0 });
      const [name, path, version, enabled] = await client.readContract({
        address, abi, functionName: 'services', args: [SERVICE_ID], blockNumber: block
      });
      return { id: SERVICE_ID, address, chainId, name, path, version: version.toString(), enabled, block: block.toString() };
    }
  };
}

export async function localRegistry(port = 8547) {
  const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--silent'], { stdio: 'ignore' });
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const close = () => child.kill();
  const rpc = 'http://127.0.0.1:' + port;
  const client = createPublicClient({ transport: http(rpc, { timeout: 700, retryCount: 0 }) });
  const wallet = createWalletClient({ transport: http(rpc) });
  try {
    let accounts;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (spawnError || child.exitCode !== null) break;
      try {
        accounts = await wallet.getAddresses();
        await delay(50);
        if (child.exitCode !== null) throw new Error('Anvil exited');
        break;
      } catch {
        accounts = undefined;
        await delay(100);
      }
    }
    if (!accounts?.length || child.exitCode !== null) {
      throw new Error('Could not start Anvil. Install Foundry or choose a free ANVIL_PORT.', { cause: spawnError });
    }
    const [owner, other] = accounts;
    const { abi, bytecode } = registryArtifact();
    const deployment = await client.waitForTransactionReceipt({
      hash: await wallet.deployContract({ abi, bytecode, account: owner, chain: null }),
      pollingInterval: 100
    });
    if (!deployment.contractAddress || deployment.status !== 'success') throw new Error('Registry deployment failed');
    const address = deployment.contractAddress;
    const configure = async (id, name, path, enabled, account = owner) => {
      const { request } = await client.simulateContract({
        address, abi, account, functionName: 'configure', args: [id, name, path, enabled]
      });
      const result = await client.waitForTransactionReceipt({
        hash: await wallet.writeContract({ ...request, chain: null }),
        pollingInterval: 100
      });
      if (result.status !== 'success') throw new Error('Registry configuration failed');
      return result;
    };
    await configure(SERVICE_ID, REPORT_NAME, REPORT_PATH, true);
    return { ...(await connectRegistry(rpc, address)), rpc, address, client, owner, other, configure, close };
  } catch (error) {
    close();
    throw error;
  }
}
