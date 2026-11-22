import { getService, mountShell, paymentNetworks, readHistory, readJson as json, saveRecord } from './shell.js';

mountShell();

const byId = id => document.getElementById(id);
const text = (id, value) => { byId(id).textContent = value; };
const steps = Array.from(byId('steps').children);
const action = byId('action');
let service;
let phase = 'request';
let busy = false;

let runId;

function record(status, data) {
  if (runId && !saveRecord({ id: runId, date: new Date().toISOString(), mode: service.payment.mode, status, data })) {
    showNotice('Browser storage is unavailable. The result remains visible on this page.', true);
  }
}

function showNotice(message, error = false) {
  const notice = byId('notice');
  notice.textContent = message;
  notice.hidden = !message;
  notice.classList.toggle('error', error);
}

function setStep(index) {
  steps.forEach((step, position) => {
    step.classList.toggle('done', position < index);
    if (position === index) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
}

function updateAction() {
  const labels = {
    load: 'Retry registry lookup',
    request: 'Request payment terms',
    pay: 'Simulate payment',
    external: 'Request terms again',
    complete: 'Start another request'
  };
  action.disabled = busy || (phase !== 'load' && !service?.available);
  action.textContent = busy ? 'Working…' : labels[phase];
}

function decodeHeader(value) {
  if (!value) throw new Error('Expected an x402 response header');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), char => char.charCodeAt(0))));
}

async function loadService() {
  service = await getService();
  const { payment, registry, available } = service;
  const mode = payment.mode;
  text('title', registry.name || 'Service status report');
  text('availability', available ? 'Enabled' : 'Unavailable');
  byId('availability').classList.toggle('good', available);
  byId('availability').classList.toggle('bad', !available);
  const version = registry.version === '0' ? 'Unregistered' : 'v' + registry.version;
  text('price', payment.displayPrice);
  text('payment-network', paymentNetworks[mode] + ' · ' + payment.network);
  text('service-version', version);
  text('registry-note', 'Chain ' + registry.chainId + ' · block ' + registry.block + ' · ' + version);
  text('conditions', {
    local: 'Local facilitator and demo credits. No wallet or funds required.',
    passport: 'Requires a funded Kite Agent Passport session with approval for Base USDC.',
    'kite-testnet': 'Requires a Kite testnet x402 payer and pieUSD.'
  }[mode]);
  phase = 'request';
  if (!available) {
    showNotice('The contract registration is disabled, missing, or configured for a different path.', true);
  }
}

async function requestTerms() {
  phase = 'request';
  runId = Array.from(crypto.getRandomValues(new Uint8Array(32)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  setStep(0);
  for (const id of ['step-terms', 'step-payment', 'step-result']) text(id, '');
  byId('terms-panel').hidden = true;
  byId('result-panel').hidden = true;
  const response = await fetch('/api/report', { signal: AbortSignal.timeout(30_000) });
  if (response.status !== 402) {
    await json(response);
    throw new Error('Expected HTTP 402 payment terms');
  }
  const { accepts, x402Version } = decodeHeader(response.headers.get('payment-required'));
  const terms = accepts?.[0];
  if (x402Version !== 2 || !terms || terms.network !== service.payment.network ||
      terms.amount !== service.payment.amount || terms.scheme !== 'exact' ||
      terms.asset !== service.payment.asset || terms.payTo !== service.payment.payTo) {
    throw new Error('The received payment terms differ from the advertised service.');
  }
  showTerms(terms);
  record('HTTP 402', terms);
}

function showTerms(terms) {
  const { mode } = service.payment;
  phase = mode === 'local' ? 'pay' : 'external';
  text('terms-scheme', 'x402 v2 · ' + terms.scheme + ' · ' + terms.network);
  text('terms-asset', service.payment.displayPrice + ' · ' + terms.asset);
  text('terms-recipient', terms.payTo);
  text('terms-timeout', terms.maxTimeoutSeconds + ' seconds');
  byId('terms-panel').hidden = false;
  byId('cli-panel').hidden = mode === 'local';
  byId('check-result').disabled = false;
  text('copy-command', mode === 'passport' ? 'Copy command' : 'Copy request details');
  if (mode === 'passport') {
    text('cli-guide', 'Run with your approved Passport session. This command can spend real USDC.');
    text('cli-command', "kpass session execute --url '" + service.endpoint +
      "' --method GET --headers '" + JSON.stringify({ 'X-Console-Run': runId }) + "' --output json");
  } else if (mode === 'kite-testnet') {
    text('cli-guide', 'Use a Kite testnet-compatible x402 v2 client with a pieUSD EIP-3009 signer.');
    text('cli-command', service.endpoint + '\nX-Console-Run: ' + runId);
  }
  text('step-request', 'HTTP 402 received');
  text('step-terms', service.payment.displayPrice + ' · x402 v2');
  setStep(1);
  if (mode !== 'local') {
    text('step-payment', 'Waiting for an external payer');
    showNotice('Run the external request, then check for its receipt.');
  }
}

async function simulate() {
  setStep(2);
  text('step-payment', 'Verifying demo authorization…');
  const { paymentSignature } = await json(await fetch('/api/demo/authorize', {
    method: 'POST', signal: AbortSignal.timeout(10_000)
  }));
  const response = await fetch('/api/report', {
    headers: { 'Payment-Signature': paymentSignature },
    signal: AbortSignal.timeout(20_000)
  });
  if (response.status === 402) throw new Error('The demo authorization or settlement was rejected.');
  const payload = await json(response);
  await displayResult(payload, decodeHeader(response.headers.get('payment-response')));
}

async function displayResult(payload, receipt) {
  const { report, sha256, mode } = payload;
  const local = service.payment.mode === 'local';
  const transactionPattern = local ? /^demo-[a-f0-9]{64}$/ : /^0x[a-f0-9]{64}$/i;
  if (mode !== service.payment.mode || receipt.success !== true ||
      receipt.network !== service.payment.network || !transactionPattern.test(receipt.transaction)) {
    throw new Error('The settlement receipt is invalid for this payment mode.');
  }
  const bytes = new TextEncoder().encode(JSON.stringify(report));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== sha256) throw new Error('The report failed its SHA-256 integrity check.');
  text('step-payment', local ? 'Demo receipt accepted' : 'Facilitator receipt received');
  text('step-result', 'HTTP 200 · report digest matched');
  text('receipt', receipt.transaction);
  if (!local) {
    const link = document.createElement('a');
    link.href = service.payment.explorer + receipt.transaction;
    link.textContent = receipt.transaction;
    byId('receipt').replaceChildren(link);
  }
  text('digest', digest);
  text('blob', JSON.stringify(report, null, 2));
  byId('result-panel').hidden = false;
  setStep(4);
  phase = 'complete';
  record('HTTP 200', { report, sha256, receipt });
}

async function run() {
  if (busy) return;
  busy = true;
  updateAction();
  showNotice('');
  try {
    if (!service || phase === 'complete') {
      const initial = !service;
      await loadService();
      if (initial && service.available && service.payment.mode !== 'local') {
        const pending = readHistory().find(entry => entry.mode === service.payment.mode && entry.status === 'HTTP 402' &&
          /^[a-f0-9]{64}$/.test(entry.id) && Date.now() - new Date(entry.date).getTime() < 900_000);
        if (pending) {
          runId = pending.id;
          showTerms(pending.data);
        }
      }
      if (byId('result-panel').hidden === false) {
        byId('terms-panel').hidden = true;
        byId('result-panel').hidden = true;
        setStep(0);
        text('step-request', 'Fetch the x402 endpoint');
        for (const id of ['step-terms', 'step-payment', 'step-result']) text(id, '');
      }
    } else if (phase === 'pay') await simulate();
    else await requestTerms();
  } catch (error) {
    if (service) record('Failed', { message: error.message });
    showNotice(error.message, true);
    if (!service) {
      phase = 'load';
      text('availability', 'Unavailable');
      text('conditions', 'The service registry could not be read.');
    } else if (phase === 'pay') {
      text('step-payment', 'Simulation failed');
    }
  } finally {
    busy = false;
    updateAction();
  }
}

byId('copy-command').addEventListener('click', async () => {
  const label = service.payment.mode === 'passport' ? 'Command' : 'Request details';
  try {
    await navigator.clipboard.writeText(byId('cli-command').textContent);
    showNotice(label + ' copied.');
  } catch {
    showNotice('Clipboard unavailable. Select the text to copy it manually.', true);
  }
});

byId('check-result').addEventListener('click', async () => {
  if (busy || phase !== 'external') return;
  busy = true;
  updateAction();
  byId('check-result').disabled = true;
  try {
    const response = await fetch('/api/runs/' + runId, { signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) {
      showNotice('A settled result is not available yet for this run.');
      return;
    }
    const payload = await json(response);
    showNotice('');
    await displayResult(payload, payload.receipt);
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    busy = false;
    updateAction();
    byId('check-result').disabled = phase !== 'external';
  }
});
action.addEventListener('click', run);
await run();
