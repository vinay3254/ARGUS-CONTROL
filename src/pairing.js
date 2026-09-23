const crypto = require('node:crypto');

class PairingManager {
  constructor({ codeTtlMs = 5 * 60 * 1000, maxAttemptsPerMinute = 10 } = {}) {
    this.codeTtlMs = codeTtlMs;
    this.maxAttemptsPerMinute = maxAttemptsPerMinute;
    this.currentCode = null;
    this.codeExpiresAt = 0;
    this.activeToken = null;
    this.attempts = new Map(); // key -> array of timestamps
  }

  generateCode() {
    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    this.currentCode = code;
    this.codeExpiresAt = Date.now() + this.codeTtlMs;
    return code;
  }

  validateCode(code) {
    if (!this.currentCode) return false;
    if (Date.now() > this.codeExpiresAt) {
      this.currentCode = null;
      return false;
    }
    if (code !== this.currentCode) return false;

    this.currentCode = null;
    this.activeToken = crypto.randomUUID();
    return true;
  }

  getActiveToken() {
    return this.activeToken;
  }

  validateToken(token) {
    return this.activeToken !== null && token === this.activeToken;
  }

  recordAttempt(key) {
    const now = Date.now();
    const windowStart = now - 60_000;
    const timestamps = (this.attempts.get(key) || []).filter((t) => t > windowStart);
    timestamps.push(now);
    this.attempts.set(key, timestamps);
    return timestamps.length <= this.maxAttemptsPerMinute;
  }
}

module.exports = { PairingManager };
