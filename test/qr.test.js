const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generatePairingQr } = require('../src/qr');

test('generatePairingQr returns a non-empty PNG buffer', async () => {
  const buf = await generatePairingQr('https://192.168.1.50:8443?pair=123456');
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 0);
  // PNG magic bytes
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});
