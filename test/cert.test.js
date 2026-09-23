const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getOrCreateCert } = require('../src/cert');

test('generates a new PEM key+cert into an empty dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-remote-cert-'));
  const { key, cert } = getOrCreateCert(dir);
  assert.match(key, /-----BEGIN (RSA )?PRIVATE KEY-----/);
  assert.match(cert, /-----BEGIN CERTIFICATE-----/);
  assert.ok(fs.existsSync(path.join(dir, 'key.pem')));
  assert.ok(fs.existsSync(path.join(dir, 'cert.pem')));
});

test('reuses an existing cert instead of regenerating', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-remote-cert-'));
  const first = getOrCreateCert(dir);
  const second = getOrCreateCert(dir);
  assert.equal(first.key, second.key);
  assert.equal(first.cert, second.cert);
});
