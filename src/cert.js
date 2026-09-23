const fs = require('node:fs');
const path = require('node:path');
const selfsigned = require('selfsigned');

function getOrCreateCert(certDir) {
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      key: fs.readFileSync(keyPath, 'utf8'),
      cert: fs.readFileSync(certPath, 'utf8'),
    };
  }

  const attrs = [{ name: 'commonName', value: 'phone-remote.local' }];
  const pems = selfsigned.generate(attrs, {
    keySize: 2048,
    days: 3650,
    algorithm: 'sha256',
  });

  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);

  return { key: pems.private, cert: pems.cert };
}

module.exports = { getOrCreateCert };
