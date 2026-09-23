// server.js
const os = require('node:os');
const https = require('node:https');
const path = require('node:path');
const express = require('express');

const { detectEnvironment } = require('./src/session');
const { getOrCreateCert } = require('./src/cert');
const { PairingManager } = require('./src/pairing');
const { generatePairingQr } = require('./src/qr');
const { CaptureSource } = require('./src/capture');
const { InputExecutor } = require('./src/inputExecutor');
const { attachWsServer } = require('./src/wsServer');

const PORT = 8443;

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  throw new Error('no non-internal IPv4 interface found');
}

function main() {
  const env = detectEnvironment();
  const lanIp = getLanIp();
  const certDir = path.join(os.homedir(), '.phone-remote', 'cert');
  const { key, cert } = getOrCreateCert(certDir);

  const pairingManager = new PairingManager();
  const captureSource = new CaptureSource({ backend: env.captureBackend, fps: 30 });
  const inputExecutor = new InputExecutor();

  if (!inputExecutor.isReady()) {
    console.warn('[phone-remote] ydotoold is not running. Input control will be disabled until you start it (see README).');
  }

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/pair-qr', async (req, res) => {
    const code = pairingManager.generateCode();
    const url = `https://${lanIp}:${PORT}/`;
    const png = await generatePairingQr(`${url}?pair=${code}`);
    res.set('Content-Type', 'image/png');
    res.send(png);
    console.log(`[phone-remote] pairing code: ${code}`);
  });

  app.post('/pair', (req, res) => {
    const ip = req.ip;
    if (!pairingManager.recordAttempt(ip)) {
      res.status(429).json({ error: 'too many attempts' });
      return;
    }
    const { code } = req.body;
    if (pairingManager.validateCode(code)) {
      res.json({ token: pairingManager.getActiveToken() });
    } else {
      res.status(401).json({ error: 'invalid or expired code' });
    }
  });

  const httpsServer = https.createServer({ key, cert }, app);
  attachWsServer({ httpsServer, pairingManager, captureSource, inputExecutor });

  captureSource.start();
  captureSource.on('error', (err) => console.error('[phone-remote] capture error:', err.message));
  captureSource.on('exit', (code) => {
    console.warn(`[phone-remote] capture process exited (code ${code}), will restart on next connection`);
  });

  httpsServer.listen(PORT, lanIp, () => {
    const url = `https://${lanIp}:${PORT}/`;
    console.log(`[phone-remote] serving on ${url}`);
    console.log(`[phone-remote] session: ${env.sessionType} (${env.desktop}), backend: ${env.captureBackend}`);
    console.log('[phone-remote] open the URL above on your phone, or scan the QR at /pair-qr');
  });
}

main();
