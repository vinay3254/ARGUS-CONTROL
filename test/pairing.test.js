const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PairingManager } = require('../src/pairing');

test('generateCode returns a 6-digit zero-padded string', () => {
  const pm = new PairingManager();
  const code = pm.generateCode();
  assert.match(code, /^\d{6}$/);
});

test('validateCode accepts the current code once, then rejects it', () => {
  const pm = new PairingManager();
  const code = pm.generateCode();
  assert.equal(pm.validateCode(code), true);
  assert.equal(pm.validateCode(code), false);
});

test('validateCode rejects wrong codes', () => {
  const pm = new PairingManager();
  pm.generateCode();
  assert.equal(pm.validateCode('000000'), false);
});

test('successful validateCode issues an active token', () => {
  const pm = new PairingManager();
  const code = pm.generateCode();
  pm.validateCode(code);
  const token = pm.getActiveToken();
  assert.equal(typeof token, 'string');
  assert.equal(pm.validateToken(token), true);
});

test('a second successful pairing invalidates the previous token', () => {
  const pm = new PairingManager();
  const code1 = pm.generateCode();
  pm.validateCode(code1);
  const token1 = pm.getActiveToken();

  const code2 = pm.generateCode();
  pm.validateCode(code2);
  const token2 = pm.getActiveToken();

  assert.notEqual(token1, token2);
  assert.equal(pm.validateToken(token1), false);
  assert.equal(pm.validateToken(token2), true);
});

test('code expires after codeTtlMs', () => {
  const pm = new PairingManager({ codeTtlMs: 10 });
  const code = pm.generateCode();
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(pm.validateCode(code), false);
      resolve();
    }, 20);
  });
});

test('recordAttempt rejects after maxAttemptsPerMinute for the same key', () => {
  const pm = new PairingManager({ maxAttemptsPerMinute: 3 });
  assert.equal(pm.recordAttempt('1.2.3.4'), true);
  assert.equal(pm.recordAttempt('1.2.3.4'), true);
  assert.equal(pm.recordAttempt('1.2.3.4'), true);
  assert.equal(pm.recordAttempt('1.2.3.4'), false);
});

test('recordAttempt tracks separate keys independently', () => {
  const pm = new PairingManager({ maxAttemptsPerMinute: 1 });
  assert.equal(pm.recordAttempt('a'), true);
  assert.equal(pm.recordAttempt('b'), true);
  assert.equal(pm.recordAttempt('a'), false);
});
