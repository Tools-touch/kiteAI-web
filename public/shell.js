const links = [
  ['/', 'Overview'],
  ['/services', 'Services'],
  ['/passport', 'Passport'],
  ['/requests', 'Requests'],
  ['/registry', 'Registry']
];

export const paymentNetworks = {
  local: 'Local simulation',
  passport: 'Base mainnet',
  'kite-testnet': 'KiteAI Testnet'
};

export function mountShell() {
  const shell = document.getElementById('shell');
  shell.innerHTML = `
    <div class="topbar-inner">
      <a href="/" class="brand"><span class="kite" aria-hidden="true"></span><span>Kite Service Console</span></a>
      <span class="badge mode" id="mode">Loading mode</span>
    </div>
    <nav class="nav" aria-label="Console navigation">
      ${links.map(([url, name]) => `<a href="${url}">${name}</a>`).join('')}
    </nav>`;
  const path = location.pathname === '/services/status-report' ? '/services' : location.pathname;
  shell.querySelector(`.nav a[href="${path}"]`)?.setAttribute('aria-current', 'page');
}

export function showMode(mode) {
  document.getElementById('mode').textContent = mode === 'passport' ? 'Passport · Base mainnet' : paymentNetworks[mode];
}

export async function readJson(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'HTTP ' + response.status);
  return body;
}

export async function getService() {
  const service = await readJson(await fetch('/api/service', { signal: AbortSignal.timeout(10_000) }));
  showMode(service.payment.mode);
  return service;
}

const historyKey = 'kite-console-requests-v1';

export function readHistory() {
  try {
    const records = JSON.parse(localStorage.getItem(historyKey) || '[]');
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

export function saveRecord(record) {
  try {
    const records = readHistory().filter(entry => entry.id !== record.id);
    localStorage.setItem(historyKey, JSON.stringify([record, ...records].slice(0, 20)));
    return true;
  } catch {
    return false;
  }
}
