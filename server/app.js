import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { decodePaymentResponseHeader, decodePaymentSignatureHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { localFacilitator } from './payments.js';
import { REPORT_PATH } from './registry.js';
import { walletQuotes } from './wallet-quotes.js';
import { walletBrowserAsset } from './wallet-asset.js';
import { KITE_WALLET } from '../shared/kite-wallet.js';

const font = fileURLToPath(new URL('../node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2', import.meta.url));
const views = fileURLToPath(new URL('./views', import.meta.url));
const publicFiles = fileURLToPath(new URL('../public', import.meta.url));

function available(service) {
  return service.enabled && service.version !== '0' && service.path === REPORT_PATH;
}

function createReport(service) {
  return {
    reportId: randomUUID(),
    generatedAt: new Date().toISOString(),
    status: 'operational',
    registry: service
  };
}

export function createApp({ registry, payment, publicOrigin, facilitator, report = createReport, now }) {
  const app = express();
  app.disable('x-powered-by');
  app.enable('case sensitive routing');
  app.enable('strict routing');
  const { info, price, requirements } = payment;
  const resource = publicOrigin && publicOrigin + REPORT_PATH;
  const quotes = walletQuotes({ payment: info, resource, now });
  const local = info.mode === 'local' ? localFacilitator(requirements) : undefined;
  const paymentServer = new x402ResourceServer(facilitator ?? local ?? payment.facilitator)
    .register(info.network, new ExactEvmScheme());
  const runs = new Map();
  const pending = new Map();
  const runKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const cleanRuns = () => {
    for (const [key, run] of runs) {
      if (run.expires <= Date.now()) runs.delete(key);
    }
  };
  const paymentGate = paymentMiddleware({
    ['GET ' + REPORT_PATH]: {
      accepts: {
        scheme: requirements.scheme, network: info.network, payTo: requirements.payTo,
        price, maxTimeoutSeconds: requirements.maxTimeoutSeconds
      },
      ...(resource && { resource }),
      description: 'Service status and registry report',
      mimeType: 'application/json'
    }
  }, paymentServer);

  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const readRegistry = async (res) => {
    try {
      return await registry.read();
    } catch {
      res.status(503).json({ error: 'Service registry is unavailable' });
    }
  };

  app.get('/api/service', async (_req, res) => {
    const registryEntry = await readRegistry(res);
    if (!registryEntry) return;
    res.json({
      registry: registryEntry, available: available(registryEntry), payment: info,
      ...(publicOrigin && { endpoint: publicOrigin + REPORT_PATH })
    });
  });

  app.get('/api/integration', async (_req, res) => {
    if (local) return res.json({ mode: info.mode, supported: null, sessionVerified: false });
    try {
      const { kinds } = await (facilitator ?? payment.facilitator).getSupported();
      const supported = kinds.some(kind => kind.x402Version === 2 &&
        kind.scheme === 'exact' && kind.network === info.network);
      res.json({ mode: info.mode, supported, sessionVerified: false });
    } catch {
      res.status(502).json({ error: 'Facilitator capability check failed' });
    }
  });

  if (!local) {
    app.get('/api/runs/:key', (req, res) => {
      cleanRuns();
      const run = runKey(req.params.key) && runs.get(req.params.key);
      if (!run) return res.status(404).json({ error: 'No settled result for this request' });
      res.json(run.result);
    });
  }

  if (local) {
    app.post('/api/demo/authorize', async (req, res) => {
      const service = await readRegistry(res);
      if (!service) return;
      if (!available(service)) return res.status(503).json({ error: 'Service is disabled or misconfigured' });
      const resource = { url: req.protocol + '://' + req.get('host') + REPORT_PATH, mimeType: 'application/json' };
      res.json({ paymentSignature: encodePaymentSignatureHeader(local.authorize(resource)) });
    });
  }

  app.all(REPORT_PATH, async (req, res, next) => {
    if (req.method !== 'GET') return res.set('Allow', 'GET').status(405).json({ error: 'Use GET' });
    const service = await readRegistry(res);
    if (!service) return;
    if (!available(service)) return res.status(503).json({ error: 'Service is disabled or misconfigured' });
    const signature = req.get('Payment-Signature') || req.get('X-Payment');
    let payload;
    if (signature) {
      try {
        payload = decodePaymentSignatureHeader(signature);
      } catch {
        delete req.headers['payment-signature'];
        delete req.headers['x-payment'];
      }
    }
    const key = req.get('X-Console-Run');
    const quote = quotes.check({
      key: runKey(key) ? key : undefined, wallet: req.get('X-Console-Wallet'),
      payload, version: service.version, hasQuery: req.originalUrl.includes('?')
    });
    if (quote.error) return res.status(quote.status).json({ error: quote.error });
    if (quote.header) res.set('X-Console-Quote', quote.header);
    if (!local && runKey(key) && payload) {
      cleanRuns();
      const now = Date.now();
      for (const [id, expiry] of pending) {
        if (expiry <= now) pending.delete(id);
      }
      if (runs.has(key) || pending.has(key)) {
        return res.status(409).json({ error: 'This console run already has a payment attempt in progress or a receipt' });
      }
      if (pending.size >= 1024) return res.status(503).json({ error: 'Too many concurrent payment attempts' });
      const expiry = now + 900_000;
      pending.set(key, expiry);
      res.locals.runKey = key;
      res.once('finish', () => {
        if (pending.get(key) === expiry) pending.delete(key);
      });
    }
    quote.consume?.();
    res.locals.registryVersion = service.version;
    next();
  }, paymentGate, async (_req, res) => {
    const service = await readRegistry(res);
    if (!service) return;
    if (!available(service) || service.version !== res.locals.registryVersion) {
      return res.status(503).json({ error: 'Service configuration changed during the request' });
    }
    try {
      const result = await report(service);
      const sha256 = createHash('sha256').update(JSON.stringify(result)).digest('hex');
      const response = { report: result, sha256, mode: info.mode };
      const key = res.locals.runKey;
      if (key) {
        res.once('finish', () => {
          const header = res.getHeader('Payment-Response');
          if (res.statusCode !== 200 || typeof header !== 'string') return;
          try {
            const receipt = decodePaymentResponseHeader(header);
            if (receipt.success !== true || receipt.network !== info.network ||
                !/^0x[a-f0-9]{64}$/i.test(receipt.transaction)) return;
            cleanRuns();
            if (runs.has(key)) return;
            if (runs.size >= 1024) runs.delete(runs.keys().next().value);
            runs.set(key, { result: { ...response, receipt }, expires: Date.now() + 900_000 });
          } catch {
            // A malformed receipt cannot be retrieved as a successful run.
          }
        });
      }
      res.json(response);
    } catch {
      res.status(502).json({ error: 'Report generation failed' });
    }
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found' }));
  if (info.mode === KITE_WALLET.mode) {
    app.get('/assets/wallet.js', async (_req, res) => {
      res.type('text/javascript').send(await walletBrowserAsset());
    });
  }
  app.get('/assets/bricolage.woff2', (_req, res) => res.sendFile(font));
  app.get(['/services', '/passport', '/requests', '/registry'], (_req, res) => {
    res.sendFile('pages.html', { root: views });
  });
  app.get('/services/status-report', (_req, res) => {
    res.sendFile('detail.html', { root: views });
  });
  app.get('/', (_req, res) => res.sendFile('pages.html', { root: views }));
  app.use(express.static(publicFiles, { index: false }));
  return app;
}
