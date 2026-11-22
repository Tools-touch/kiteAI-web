import { getService, mountShell, paymentNetworks, readHistory, readJson } from './shell.js';

mountShell();
const root = document.getElementById('page');
const title = {
  '/': ['Developer console', 'Service Console', 'Request a service report through x402.'],
  '/services': ['Services', 'Service catalog', 'Explore the service registered on the configured chain.'],
  '/passport': ['Integration', 'Kite Agent Passport', 'Connect an official Passport agent as an external x402 payer.'],
  '/requests': ['Activity', 'Requests & receipts', 'Inspect calls made from this browser.'],
  '/registry': ['On-chain configuration', 'Service registry', 'Read the current ServiceRegistry entry from the configured RPC.']
}[location.pathname];

const [eyebrow, heading, subtitle] = title;
document.title = heading + ' · Kite Service Console';
root.innerHTML = `
  <section class="hero">
    <div><p class="eyebrow">${eyebrow}</p><h1>${heading}</h1><p class="subtitle">${subtitle}</p></div>
    <div class="orbit" aria-hidden="true"><i></i><i></i><i></i><b></b><b></b><b></b></div>
  </section>
  <div id="content" class="stack"></div>`;
const content = document.getElementById('content');
const value = (id, text) => { document.getElementById(id).textContent = text; };
const money = payment => payment.displayPrice + ' · ' + paymentNetworks[payment.mode];

function overview(service) {
  content.innerHTML = `
    <div class="summary">
      <section class="panel">
        <div class="panel-title"><h2>Run a service request</h2><span id="availability" class="badge"></span></div>
        <p>Get payment terms, submit an authorization and inspect the report and receipt.</p>
        <a class="primary inline-primary" href="/services/status-report">Open service</a>
      </section>
      <section class="panel">
        <h2>Environment</h2>
        <dl class="rows">
          <div><dt>Payment</dt><dd id="payment"></dd></div>
          <div><dt>Registry</dt><dd id="chain"></dd></div>
        </dl>
        <a href="/passport">Passport integration</a>
      </section>
    </div>`;
  value('availability', service.available ? 'Enabled' : 'Unavailable');
  document.getElementById('availability').classList.add(service.available ? 'good' : 'bad');
  value('payment', money(service.payment));
  value('chain', 'EVM chain ' + service.registry.chainId);
}

function catalog(service) {
  content.innerHTML = `
    <article class="panel catalog-card">
      <div><h2 id="name"></h2><div class="endpoint"><span>GET</span><code>/api/report</code></div></div>
      <span class="badge" id="status"></span>
      <dl class="rows">
        <div><dt>Price</dt><dd id="price"></dd></div>
        <div><dt>Config version</dt><dd id="version"></dd></div>
      </dl>
      <div class="toolbar"><a class="primary inline-primary" href="/services/status-report">View service &amp; request</a></div>
    </article>`;
  value('name', service.registry.name || 'Service status report');
  value('status', service.available ? 'Enabled' : 'Unavailable');
  document.getElementById('status').classList.add(service.available ? 'good' : 'bad');
  value('price', money(service.payment));
  value('version', service.registry.version === '0' ? 'Unregistered' : 'v' + service.registry.version);
}

function passport(service) {
  const mode = service.payment.mode;
  content.innerHTML = `
    <div class="summary">
      <section class="panel">
        <h2>Integration status</h2>
        <dl class="rows">
          <div><dt>Configured mode</dt><dd id="configured"></dd></div>
          <div><dt>Facilitator</dt><dd id="facilitator"></dd></div>
          <div><dt>Passport session</dt><dd id="session-status"></dd></div>
        </dl>
        <button class="secondary" id="check" type="button">Check facilitator</button>
        <p class="conditions" id="capability" role="status"></p>
      </section>
      <section class="panel">
        <h2>Connect an agent</h2>
        <ol class="prose">
          <li>Set up an agent in Passport and fund its wallet on a supported network.</li>
          <li>Approve a spending session for the merchant and payment terms.</li>
          <li>Run the command shown alongside the quote on the service page.</li>
        </ol>
        <div class="toolbar">
          <a class="secondary" href="/services/status-report">Open service</a>
          <a class="secondary" href="https://docs.gokite.ai/passport/payments">Official payment guide</a>
        </div>
      </section>
    </div>`;
  value('configured', mode === 'passport' ? 'Passport · Base USDC' : paymentNetworks[mode]);
  value('session-status', mode === 'passport' ? 'External · unverified' : 'Outside this payment mode');
  value('facilitator', mode === 'local' ? 'In-process simulator' : 'Pieverse x402 v2');
  value('capability', {
    local: 'This preview uses demo authorizations. Switch the server to Passport mode for an official payer.',
    passport: 'A facilitator capability check is read-only. Session and settlement are verified during a paid request.',
    'kite-testnet': 'This merchant profile targets Kite testnet. Check compatibility with your Passport environment before using it.'
  }[mode]);
  const button = document.getElementById('check');
  button.disabled = mode === 'local';
  button.addEventListener('click', async () => {
    button.disabled = true;
    value('capability', 'Checking advertised facilitator capabilities…');
    try {
      const check = await readJson(await fetch('/api/integration', { signal: AbortSignal.timeout(25_000) }));
      value('capability', check.supported
        ? 'The facilitator currently advertises x402 v2 exact on ' + service.payment.network + '.'
        : 'The facilitator did not advertise this network and scheme.');
    } catch (error) {
      value('capability', error.message);
    } finally {
      button.disabled = false;
    }
  });
}

function registry(service) {
  const entry = service.registry;
  content.innerHTML = `
    <section class="panel">
      <div class="panel-title"><h2 id="name"></h2><span class="badge cyan" id="block"></span></div>
      <dl class="rows">
        <div><dt>Network</dt><dd id="network"></dd></div>
        <div><dt>Contract</dt><dd class="address"><code id="address"></code><button class="copy" id="copy" type="button">Copy</button></dd></div>
        <div><dt>Service ID</dt><dd id="id"></dd></div>
        <div><dt>HTTP path</dt><dd id="path"></dd></div>
        <div><dt>Config version</dt><dd id="version"></dd></div>
        <div><dt>Contract state</dt><dd id="status"></dd></div>
      </dl>
      <p class="conditions">The contract supplies service metadata and availability. The x402 facilitator verifies and settles payments.</p>
      <span class="sr-only" role="status" id="copied"></span>
    </section>`;
  value('name', entry.name || 'Service status report');
  value('block', 'Block ' + entry.block);
  value('network', (entry.chainId === 31337 ? 'Local Anvil' : 'EVM chain') + ' · ' + entry.chainId);
  value('address', entry.address);
  value('id', entry.id);
  value('path', entry.path || 'Unregistered');
  value('version', entry.version === '0' ? 'Unregistered' : 'v' + entry.version);
  value('status', entry.enabled ? 'Enabled' : 'Disabled');
  document.getElementById('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(entry.address);
      value('copy', 'Copied');
      value('copied', 'Contract address copied');
    } catch {
      value('copied', 'Clipboard unavailable');
      value('copy', 'Copy failed');
    }
  });
}

function requests() {
  content.innerHTML = `
    <section class="panel">
      <h2>Recent requests</h2>
      <p class="conditions">Up to 20 entries are stored in this browser. Local simulation receipts are labeled.</p>
      <div class="records" id="records"></div>
      <a class="text-link" href="/services/status-report">Open service</a>
    </section>`;
  const list = document.getElementById('records');
  const records = readHistory();
  if (records.length === 0) {
    list.textContent = 'No requests yet.';
    list.classList.add('prose');
  }
  for (const record of records) {
    const element = document.createElement('details');
    element.className = 'record';
    const summary = document.createElement('summary');
    const date = new Date(record.date);
    summary.textContent = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium', timeStyle: 'medium'
    }).format(date);
    const status = document.createElement('span');
    status.className = 'status-label';
    status.textContent = record.status + ' · ' + paymentNetworks[record.mode];
    const details = document.createElement('pre');
    details.textContent = JSON.stringify(record.data, null, 2);
    summary.append(status);
    element.append(summary, details);
    list.append(element);
  }
}

const views = { '/': overview, '/services': catalog, '/passport': passport, '/registry': registry };

if (location.pathname === '/requests') {
  requests();
  getService().catch(() => value('mode', 'Mode unavailable'));
} else {
  content.innerHTML = '<p class="prose" role="status">Reading service registration…</p>';
  try {
    views[location.pathname](await getService());
  } catch (error) {
    content.innerHTML = '<section class="panel"><p id="error" class="error" role="status"></p><a class="secondary" href="">Reload page</a></section>';
    value('error', error.message);
    value('mode', 'Mode unavailable');
  }
}
