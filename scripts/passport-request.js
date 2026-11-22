import { spawnSync } from 'node:child_process';

const [target, option, extra] = process.argv.slice(2);
const usage = 'Usage: npm run passport:request -- https://your-service.example/api/report [--legacy-cli]';
let endpoint;
try {
  endpoint = new URL(target);
} catch {
  throw new Error(usage);
}
if (option && option !== '--legacy-cli' || extra || endpoint.protocol !== 'https:' ||
    endpoint.pathname !== '/api/report' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search ||
    ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
  throw new Error(usage);
}

// This is an explicit buyer command. Existing Passport session policy governs spending.
const namespace = option === '--legacy-cli' ? 'agent:session' : 'session';
const args = [namespace, 'execute', '--url', endpoint.href, '--method', 'GET', '--output', 'json', '--no-interactive'];
const result = spawnSync('kpass', args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
