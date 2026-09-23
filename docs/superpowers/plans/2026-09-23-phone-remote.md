# Phone Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Linux laptop server + installable Android PWA that streams the laptop's screen to the phone over WebRTC and lets the phone control the laptop's mouse, keyboard, and media keys over the same LAN.

**Architecture:** Node.js server (Express + `ws` on one HTTPS listener) captures the screen via `wf-recorder` (Wayland/Hyprland) or `ffmpeg x11grab` (X11), feeds raw I420 frames into a native `@roamhq/wrtc` `RTCVideoSource`, and streams it to the phone over a real `RTCPeerConnection` (host-only ICE, LAN only). The phone is an installable PWA that scans a QR code to pair, receives the video stream, and sends touch/keyboard/media events as JSON over the same WebSocket used for signaling. The server translates those events into `ydotool` commands via `ydotoold`.

**Tech Stack:** Node.js v26, Express, `ws`, `@roamhq/wrtc`, `qrcode`, `selfsigned`, `wf-recorder`/`ffmpeg` (external processes), `ydotool`/`ydotoold` (external), Node's built-in `node:test` runner (no test framework dependency). Vanilla JS/HTML/CSS PWA client, no frontend framework/bundler.

**Spec:** `docs/superpowers/specs/2026-09-23-phone-remote-design.md`

## Global Constraints

- LAN only: no STUN/TURN, no public exposure. Server binds to the LAN interface IP, never `0.0.0.0`, unless a (stubbed, unimplemented) `--tunnel` flag is passed.
- Single laptop, single active paired phone. A second successful pairing closes the first phone's connection.
- Android + Chrome only. No iOS-specific code paths.
- Wayland capture is wlroots/Hyprland only (`wf-recorder` + `hyprctl`). X11 capture is `ffmpeg x11grab`. No GNOME/KDE portal capture in v1.
- HTTPS required everywhere (self-signed cert), because both the service worker and the in-PWA camera QR scan need a secure context.
- No audio capture in v1.
- Input execution goes through `ydotool`/`ydotoold` only; `xdotool` is a fallback used solely when the session is X11 and `ydotool` is missing.
- `@roamhq/wrtc`'s `nonstandard.RTCVideoSource.onFrame()` takes **raw I420 frames** (`{width, height, data}`, `data.length === width*height*1.5`) — never pre-encoded H264. Verified locally: `wf-recorder -y --muxer=rawvideo --codec=rawvideo -x yuv420p -r 30 -f /dev/stdout` produces exactly `width*height*1.5` bytes per frame (confirmed 1920x1080 → 3,110,400 bytes/frame on this machine).
- Monitor resolution on Wayland is read via `hyprctl monitors -j`, using the entry where `focused === true`.

---

## File Structure

```
phone-remote/
  package.json
  server.js                  # entrypoint: wires everything, starts HTTPS+WS server
  src/
    session.js                # detect Wayland/X11 + capture backend
    cert.js                   # self-signed cert, cached on disk
    pairing.js                # PairingManager: codes, tokens, rate limiting
    input.js                  # pure event -> ydotool command mapper
    inputExecutor.js           # runs ydotool/xdotool via child_process
    qr.js                      # pairing QR PNG generator
    capture.js                 # CaptureSource: spawns wf-recorder/ffmpeg, emits raw frames
    webrtc.js                  # RTCPeerConnection + RTCVideoSource wiring
    wsServer.js                 # WS connection handling: auth, signaling, input routing
  public/
    manifest.json
    sw.js
    index.html
    styles.css
    app.js                      # WS client, WebRTC receive, touch handlers, pairing UI, drawer
  test/
    session.test.js
    cert.test.js
    pairing.test.js
    input.test.js
    qr.test.js
  README.md
  .gitignore
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `src/` (empty dir, created implicitly by later tasks)
- Create: `public/` (empty dir, created implicitly by later tasks)

**Interfaces:**
- Produces: `npm test` (runs `node --test test/`), `npm start` (runs `node server.js`)

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "phone-remote",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "@roamhq/wrtc": "^0.10.0",
    "express": "^4.21.0",
    "qrcode": "^1.5.4",
    "selfsigned": "^2.4.1",
    "ws": "^8.18.0"
  }
}
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
*.log
.phone-remote-cert/
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, no errors. (Already smoke-tested in a scratch dir: `@roamhq/wrtc` installs and loads without a source build on this Node v26.9.0.)

- [ ] **Step 4: Verify test runner works with zero tests**

Run: `mkdir -p test && npm test`
Expected: `node --test` exits 0 with "tests 0" (no test files yet — this just confirms the script and runner work).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore: project scaffold"
```

---

### Task 2: Session/capture-backend detection

**Files:**
- Create: `src/session.js`
- Test: `test/session.test.js`

**Interfaces:**
- Produces: `detectEnvironment(env = process.env) -> { sessionType: 'wayland' | 'x11', desktop: string, captureBackend: 'wf-recorder' | 'ffmpeg-x11grab' }`
  - Later used by: `src/capture.js` (Task 8), `server.js` (Task 11)

- [ ] **Step 1: Write the failing test**

```js
// test/session.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectEnvironment } = require('../src/session');

test('wayland session picks wf-recorder backend', () => {
  const result = detectEnvironment({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'Hyprland' });
  assert.deepEqual(result, {
    sessionType: 'wayland',
    desktop: 'Hyprland',
    captureBackend: 'wf-recorder',
  });
});

test('x11 session picks ffmpeg-x11grab backend', () => {
  const result = detectEnvironment({ XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'GNOME' });
  assert.deepEqual(result, {
    sessionType: 'x11',
    desktop: 'GNOME',
    captureBackend: 'ffmpeg-x11grab',
  });
});

test('missing XDG_CURRENT_DESKTOP defaults to empty string', () => {
  const result = detectEnvironment({ XDG_SESSION_TYPE: 'wayland' });
  assert.equal(result.desktop, '');
});

test('unknown session type throws', () => {
  assert.throws(() => detectEnvironment({ XDG_SESSION_TYPE: 'mir' }), /unsupported session type/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/session.test.js`
Expected: FAIL — `Cannot find module '../src/session'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/session.js
function detectEnvironment(env = process.env) {
  const sessionType = env.XDG_SESSION_TYPE;
  const desktop = env.XDG_CURRENT_DESKTOP || '';

  if (sessionType !== 'wayland' && sessionType !== 'x11') {
    throw new Error(`unsupported session type: ${sessionType}`);
  }

  const captureBackend = sessionType === 'wayland' ? 'wf-recorder' : 'ffmpeg-x11grab';

  return { sessionType, desktop, captureBackend };
}

module.exports = { detectEnvironment };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/session.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/session.js test/session.test.js
git commit -m "feat: detect session type and capture backend"
```

---

### Task 3: Self-signed certificate manager

**Files:**
- Create: `src/cert.js`
- Test: `test/cert.test.js`

**Interfaces:**
- Produces: `getOrCreateCert(certDir) -> { key: string, cert: string }` (both PEM strings)
  - Later used by: `server.js` (Task 11, to create the HTTPS listener)

- [ ] **Step 1: Write the failing test**

```js
// test/cert.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cert.test.js`
Expected: FAIL — `Cannot find module '../src/cert'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/cert.js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cert.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cert.js test/cert.test.js
git commit -m "feat: self-signed HTTPS cert manager"
```

---

### Task 4: Pairing manager (codes, tokens, rate limiting)

**Files:**
- Create: `src/pairing.js`
- Test: `test/pairing.test.js`

**Interfaces:**
- Produces: `class PairingManager`
  - `constructor({ codeTtlMs = 5*60*1000, maxAttemptsPerMinute = 10 } = {})`
  - `generateCode() -> string` (6-digit, zero-padded)
  - `validateCode(code) -> boolean` — on success, invalidates the code (single-use) and issues a new active token, kicking any prior token
  - `getActiveToken() -> string | null` — token issued by the last successful `validateCode`
  - `validateToken(token) -> boolean`
  - `recordAttempt(key) -> boolean` — returns `false` (rejected) once `key` exceeds `maxAttemptsPerMinute` in the current 60s window
  - Later used by: `src/wsServer.js` (Task 10), `server.js` (Task 11, `/pair` route)

- [ ] **Step 1: Write the failing test**

```js
// test/pairing.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pairing.test.js`
Expected: FAIL — `Cannot find module '../src/pairing'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/pairing.js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pairing.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/pairing.js test/pairing.test.js
git commit -m "feat: pairing manager with codes, tokens, rate limiting"
```

---

### Task 5: Input event mapper (pure function)

**Files:**
- Create: `src/input.js`
- Test: `test/input.test.js`

**Interfaces:**
- Produces: `mapEventToCommand(event) -> { tool: 'ydotool' | 'loginctl', args: string[] }`
  - Event shapes:
    - `{ type: 'move', dx: number, dy: number }`
    - `{ type: 'click', button: 'left' | 'right' }`
    - `{ type: 'scroll', dx: number, dy: number }`
    - `{ type: 'type', text: string }`
    - `{ type: 'key', name: 'volumeup'|'volumedown'|'mute'|'playpause'|'next'|'prev' }`
    - `{ type: 'lock' }`
  - Throws `Error` with message starting `unknown input event` for any other shape.
  - Later used by: `src/inputExecutor.js` (Task 6), `src/wsServer.js` (Task 10)

- [ ] **Step 1: Write the failing test**

```js
// test/input.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapEventToCommand } = require('../src/input');

test('move maps to relative ydotool mousemove', () => {
  const cmd = mapEventToCommand({ type: 'move', dx: 12, dy: -5 });
  assert.deepEqual(cmd, { tool: 'ydotool', args: ['mousemove', '--', '12', '-5'] });
});

test('click left maps to ydotool click 0x00', () => {
  const cmd = mapEventToCommand({ type: 'click', button: 'left' });
  assert.deepEqual(cmd, { tool: 'ydotool', args: ['click', '0x00'] });
});

test('click right maps to ydotool click 0x01', () => {
  const cmd = mapEventToCommand({ type: 'click', button: 'right' });
  assert.deepEqual(cmd, { tool: 'ydotool', args: ['click', '0x01'] });
});

test('scroll maps to relative wheel mousemove', () => {
  const cmd = mapEventToCommand({ type: 'scroll', dx: 0, dy: 3 });
  assert.deepEqual(cmd, { tool: 'ydotool', args: ['mousemove', '-w', '--', '0', '3'] });
});

test('type maps to ydotool type with the raw string', () => {
  const cmd = mapEventToCommand({ type: 'type', text: 'hello world' });
  assert.deepEqual(cmd, { tool: 'ydotool', args: ['type', '--', 'hello world'] });
});

test('media keys map to correct evdev keycodes (press+release)', () => {
  assert.deepEqual(mapEventToCommand({ type: 'key', name: 'volumeup' }),
    { tool: 'ydotool', args: ['key', '115:1', '115:0'] });
  assert.deepEqual(mapEventToCommand({ type: 'key', name: 'volumedown' }),
    { tool: 'ydotool', args: ['key', '114:1', '114:0'] });
  assert.deepEqual(mapEventToCommand({ type: 'key', name: 'mute' }),
    { tool: 'ydotool', args: ['key', '113:1', '113:0'] });
  assert.deepEqual(mapEventToCommand({ type: 'key', name: 'playpause' }),
    { tool: 'ydotool', args: ['key', '164:1', '164:0'] });
  assert.deepEqual(mapEventToCommand({ type: 'key', name: 'next' }),
    { tool: 'ydotool', args: ['key', '163:1', '163:0'] });
  assert.deepEqual(mapEventToCommand({ type: 'key', name: 'prev' }),
    { tool: 'ydotool', args: ['key', '165:1', '165:0'] });
});

test('lock maps to loginctl lock-session', () => {
  const cmd = mapEventToCommand({ type: 'lock' });
  assert.deepEqual(cmd, { tool: 'loginctl', args: ['lock-session'] });
});

test('unknown event type throws', () => {
  assert.throws(() => mapEventToCommand({ type: 'nonsense' }), /unknown input event/i);
});

test('unknown key name throws', () => {
  assert.throws(() => mapEventToCommand({ type: 'key', name: 'bogus' }), /unknown input event/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/input.test.js`
Expected: FAIL — `Cannot find module '../src/input'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/input.js
const MEDIA_KEYCODES = {
  volumeup: 115,
  volumedown: 114,
  mute: 113,
  playpause: 164,
  next: 163,
  prev: 165,
};

function mapEventToCommand(event) {
  switch (event.type) {
    case 'move':
      return { tool: 'ydotool', args: ['mousemove', '--', String(event.dx), String(event.dy)] };

    case 'click':
      if (event.button === 'left') return { tool: 'ydotool', args: ['click', '0x00'] };
      if (event.button === 'right') return { tool: 'ydotool', args: ['click', '0x01'] };
      break;

    case 'scroll':
      return { tool: 'ydotool', args: ['mousemove', '-w', '--', String(event.dx), String(event.dy)] };

    case 'type':
      return { tool: 'ydotool', args: ['type', '--', event.text] };

    case 'key': {
      const code = MEDIA_KEYCODES[event.name];
      if (code === undefined) break;
      return { tool: 'ydotool', args: ['key', `${code}:1`, `${code}:0`] };
    }

    case 'lock':
      return { tool: 'loginctl', args: ['lock-session'] };
  }

  throw new Error(`unknown input event: ${JSON.stringify(event)}`);
}

module.exports = { mapEventToCommand };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/input.test.js`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/input.js test/input.test.js
git commit -m "feat: pure input-event-to-ydotool-command mapper"
```

---

### Task 6: Input executor (runs commands via child_process)

**Files:**
- Create: `src/inputExecutor.js`

**Interfaces:**
- Consumes: `mapEventToCommand` output shape `{ tool, args }` from Task 5
- Produces: `class InputExecutor`
  - `constructor({ ydotoolSocket = '/tmp/.ydotool_socket' } = {})`
  - `isReady() -> boolean` (true if `ydotoolSocket` exists on disk)
  - `execute({ tool, args }) -> Promise<void>` (spawns `tool` with `args`; for `ydotool` sets `YDOTOOL_SOCKET` env var)
  - Later used by: `src/wsServer.js` (Task 10)

Not unit-tested: this task shells out to a real system daemon (`ydotoold`). It's covered by manual verification instead, per the spec's testing section.

- [ ] **Step 1: Write the implementation**

```js
// src/inputExecutor.js
const fs = require('node:fs');
const { spawn } = require('node:child_process');

class InputExecutor {
  constructor({ ydotoolSocket = '/tmp/.ydotool_socket' } = {}) {
    this.ydotoolSocket = ydotoolSocket;
  }

  isReady() {
    return fs.existsSync(this.ydotoolSocket);
  }

  execute({ tool, args }) {
    return new Promise((resolve, reject) => {
      const env = tool === 'ydotool'
        ? { ...process.env, YDOTOOL_SOCKET: this.ydotoolSocket }
        : process.env;

      const child = spawn(tool, args, { env });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });

      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${tool} exited with code ${code}: ${stderr.trim()}`));
      });
    });
  }
}

module.exports = { InputExecutor };
```

- [ ] **Step 2: Manual verification — ydotoold readiness check**

Run: `node -e "const {InputExecutor} = require('./src/inputExecutor'); console.log(new InputExecutor().isReady())"`
Expected: prints `true` if `ydotoold` is already running on this machine (start it first if needed: `sudo ydotoold &`), `false` otherwise.

- [ ] **Step 3: Manual verification — real mouse move**

With `ydotoold` running (`sudo ydotoold &`), run:
`node -e "const {InputExecutor}=require('./src/inputExecutor'); const {mapEventToCommand}=require('./src/input'); new InputExecutor().execute(mapEventToCommand({type:'move',dx:50,dy:0})).then(()=>console.log('ok')).catch(e=>console.error(e))"`
Expected: the mouse cursor visibly moves 50px right on screen, and `ok` prints.

- [ ] **Step 4: Commit**

```bash
git add src/inputExecutor.js
git commit -m "feat: input executor that runs ydotool/loginctl commands"
```

---

### Task 7: Pairing QR generator

**Files:**
- Create: `src/qr.js`
- Test: `test/qr.test.js`

**Interfaces:**
- Produces: `generatePairingQr(url) -> Promise<Buffer>` (PNG image bytes)
  - Later used by: `server.js` (Task 11, `GET /pair-qr` route)

- [ ] **Step 1: Write the failing test**

```js
// test/qr.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/qr.test.js`
Expected: FAIL — `Cannot find module '../src/qr'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/qr.js
const QRCode = require('qrcode');

function generatePairingQr(url) {
  return QRCode.toBuffer(url, { type: 'png', errorCorrectionLevel: 'M', margin: 2 });
}

module.exports = { generatePairingQr };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/qr.test.js`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add src/qr.js test/qr.test.js
git commit -m "feat: pairing QR PNG generator"
```

---

### Task 8: Screen capture pipeline

**Files:**
- Create: `src/capture.js`

**Interfaces:**
- Consumes: `detectEnvironment().captureBackend` from Task 2
- Produces: `class CaptureSource extends EventEmitter`
  - `constructor({ backend: 'wf-recorder' | 'ffmpeg-x11grab', fps = 30 })`
  - `start()` — spawns the capture process, resolves width/height, begins parsing frames
  - `stop()` — kills the capture process
  - `isRunning() -> boolean` — true while the capture child process is alive
  - events: `'frame'` with `{ width, height, data: Uint8Array }` (I420, `data.length === width*height*1.5`), `'error'` with an `Error`, `'exit'` with the child's exit code (also sets internal state so `isRunning()` returns `false`)
  - Later used by: `src/webrtc.js` (Task 9), `src/wsServer.js` (Task 10, restarts capture on next connection if it died)

Not unit-tested: spawns real external processes against the real display. Covered by manual verification.

- [ ] **Step 1: Write the implementation**

```js
// src/capture.js
const { EventEmitter } = require('node:events');
const { spawn, execFileSync } = require('node:child_process');

function getWaylandResolution() {
  const out = execFileSync('hyprctl', ['monitors', '-j'], { encoding: 'utf8' });
  const monitors = JSON.parse(out);
  const focused = monitors.find((m) => m.focused) || monitors[0];
  if (!focused) throw new Error('hyprctl reported no monitors');
  return { width: focused.width, height: focused.height };
}

function getX11Resolution() {
  const out = execFileSync('xdotool', ['getdisplaygeometry'], { encoding: 'utf8' });
  const [width, height] = out.trim().split(/\s+/).map(Number);
  return { width, height };
}

class CaptureSource extends EventEmitter {
  constructor({ backend, fps = 30 }) {
    super();
    this.backend = backend;
    this.fps = fps;
    this.child = null;
    this.width = 0;
    this.height = 0;
    this._buffer = Buffer.alloc(0);
  }

  isRunning() {
    return this.child !== null;
  }

  start() {
    const { width, height } = this.backend === 'wf-recorder'
      ? getWaylandResolution()
      : getX11Resolution();
    this.width = width;
    this.height = height;

    const frameBytes = width * height * 1.5;

    if (this.backend === 'wf-recorder') {
      this.child = spawn('wf-recorder', [
        '-y', '--muxer=rawvideo', '--codec=rawvideo', '-x', 'yuv420p',
        '-r', String(this.fps), '-f', '/dev/stdout',
      ]);
    } else {
      this.child = spawn('ffmpeg', [
        '-f', 'x11grab', '-video_size', `${width}x${height}`, '-framerate', String(this.fps),
        '-i', ':0', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1',
      ]);
    }

    this.child.stdout.on('data', (chunk) => this._onData(chunk, frameBytes));
    this.child.on('error', (err) => this.emit('error', err));
    this.child.on('exit', (code) => {
      this.child = null;
      this._buffer = Buffer.alloc(0);
      this.emit('exit', code);
    });
  }

  _onData(chunk, frameBytes) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (this._buffer.length >= frameBytes) {
      const frame = this._buffer.subarray(0, frameBytes);
      this._buffer = this._buffer.subarray(frameBytes);
      this.emit('frame', { width: this.width, height: this.height, data: new Uint8Array(frame) });
    }
  }

  stop() {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }
}

module.exports = { CaptureSource, getWaylandResolution, getX11Resolution };
```

- [ ] **Step 2: Manual verification — resolution detection**

Run: `node -e "console.log(require('./src/capture').getWaylandResolution())"`
Expected: prints `{ width: 1920, height: 1080 }` (matches this machine's `hyprctl monitors -j` output, already confirmed).

- [ ] **Step 3: Manual verification — frame capture**

Run:
```
node -e "
const {CaptureSource} = require('./src/capture');
const cs = new CaptureSource({backend:'wf-recorder', fps:30});
let count = 0;
cs.on('frame', (f) => { count++; if (count === 1) console.log('first frame', f.width, f.height, f.data.length); if (count >= 30) { console.log('got 30 frames'); cs.stop(); process.exit(0); } });
cs.on('error', (e) => { console.error(e); process.exit(1); });
cs.start();
"
```
Expected: prints `first frame 1920 1080 3110400`, then `got 30 frames` within ~1 second, process exits cleanly (no leftover `wf-recorder` process — check with `pgrep wf-recorder` afterward).

- [ ] **Step 4: Commit**

```bash
git add src/capture.js
git commit -m "feat: screen capture pipeline (wf-recorder/ffmpeg raw frames)"
```

---

### Task 9: WebRTC peer wiring

**Files:**
- Create: `src/webrtc.js`

**Interfaces:**
- Consumes: `CaptureSource` instance from Task 8 (its `'frame'` events)
- Produces: `createPeerHandler({ captureSource }) -> { pc, handleOffer(sdp) -> Promise<{type,sdp}>, addIceCandidate(candidate), onIceCandidate(cb), close() }`
  - Later used by: `src/wsServer.js` (Task 10)

Not unit-tested: requires a real native `RTCPeerConnection` and a real remote peer to be meaningful. Covered by manual verification using two Node processes.

- [ ] **Step 1: Write the implementation**

```js
// src/webrtc.js
const wrtc = require('@roamhq/wrtc');
const { RTCPeerConnection } = wrtc;
const { RTCVideoSource } = wrtc.nonstandard;

function createPeerHandler({ captureSource }) {
  const videoSource = new RTCVideoSource({ isScreencast: true });
  const track = videoSource.createTrack();

  const onFrame = (frame) => videoSource.onFrame(frame);
  captureSource.on('frame', onFrame);

  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.addTrack(track);

  let iceCandidateCb = null;
  pc.onicecandidate = (event) => {
    if (event.candidate && iceCandidateCb) iceCandidateCb(event.candidate);
  };

  async function handleOffer(sdp) {
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return { type: answer.type, sdp: answer.sdp };
  }

  function addIceCandidate(candidate) {
    return pc.addIceCandidate(candidate);
  }

  function onIceCandidate(cb) {
    iceCandidateCb = cb;
  }

  function close() {
    captureSource.off('frame', onFrame);
    pc.close();
  }

  return { pc, handleOffer, addIceCandidate, onIceCandidate, close };
}

module.exports = { createPeerHandler };
```

- [ ] **Step 2: Manual verification — two-peer smoke test on the laptop**

Run this script (creates two `RTCPeerConnection`s in the same process, offer/answer directly, no signaling server, to confirm the video track flows end-to-end before wiring up the real WS signaling in Task 10):

```
node -e "
const wrtc = require('@roamhq/wrtc');
const { CaptureSource } = require('./src/capture');
const { createPeerHandler } = require('./src/webrtc');

const cs = new CaptureSource({ backend: 'wf-recorder', fps: 30 });
const server = createPeerHandler({ captureSource: cs });
cs.start();

const client = new wrtc.RTCPeerConnection({ iceServers: [] });
client.ontrack = (e) => {
  const sink = new wrtc.nonstandard.RTCVideoSink(e.track);
  let frames = 0;
  sink.onframe = () => { frames++; if (frames === 1) console.log('client received first frame'); };
};
server.onIceCandidate((c) => client.addIceCandidate(c));
client.onicecandidate = (e) => { if (e.candidate) server.addIceCandidate(e.candidate); };

client.addTransceiver('video', { direction: 'recvonly' });
client.createOffer().then((offer) => {
  client.setLocalDescription(offer);
  return server.handleOffer(offer.sdp);
}).then((answer) => client.setRemoteDescription(answer));

setTimeout(() => { console.log('done'); process.exit(0); }, 3000);
"
```
Expected: prints `client received first frame` within ~3 seconds, then `done`.

- [ ] **Step 3: Commit**

```bash
git add src/webrtc.js
git commit -m "feat: WebRTC peer wiring with RTCVideoSource"
```

---

### Task 10: WebSocket server (auth, signaling, input routing)

**Files:**
- Create: `src/wsServer.js`

**Interfaces:**
- Consumes: `PairingManager` (Task 4), `createPeerHandler` (Task 9), `InputExecutor`+`mapEventToCommand` (Tasks 5-6)
- Produces: `attachWsServer({ httpsServer, pairingManager, captureSource, inputExecutor }) -> WebSocketServer`
  - WS message protocol (all JSON):
    - Client -> server, first message: `{ type: 'auth', token }`
    - Server -> client on auth success: `{ type: 'auth-ok' }` then `{ type: 'offer', sdp }`
    - Server -> client on auth failure: `{ type: 'auth-error' }`, then closes with code 4001
    - Client -> server: `{ type: 'answer', sdp }`
    - Either direction: `{ type: 'ice-candidate', candidate }`
    - Client -> server: `{ type: 'input', event }` where `event` matches Task 5's shapes
    - Server -> client: `{ type: 'kicked' }` before closing a connection replaced by a new pairing
    - Server -> client: `{ type: 'capture-error', message }` if the capture pipeline dies
  - Later used by: `server.js` (Task 11)

Not unit-tested: this is integration glue over real WebSocket connections and a real `RTCPeerConnection`. Covered by manual verification with a scripted WS client.

- [ ] **Step 1: Write the implementation**

```js
// src/wsServer.js
const { WebSocketServer } = require('ws');
const { createPeerHandler } = require('./webrtc');
const { mapEventToCommand } = require('./input');

function attachWsServer({ httpsServer, pairingManager, captureSource, inputExecutor }) {
  const wss = new WebSocketServer({ server: httpsServer });
  let activeConn = null; // { ws, peer }

  wss.on('connection', (ws) => {
    let authed = false;
    let peer = null;

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!authed) {
        if (msg.type !== 'auth' || !pairingManager.validateToken(msg.token)) {
          ws.send(JSON.stringify({ type: 'auth-error' }));
          ws.close(4001, 'invalid token');
          return;
        }

        if (activeConn) {
          activeConn.ws.send(JSON.stringify({ type: 'kicked' }));
          activeConn.ws.close(4002, 'paired elsewhere');
          activeConn.peer.close();
        }

        if (!captureSource.isRunning()) {
          try {
            captureSource.start();
          } catch (err) {
            ws.send(JSON.stringify({ type: 'capture-error', message: err.message || String(err) }));
          }
        }

        authed = true;
        peer = createPeerHandler({ captureSource });
        activeConn = { ws, peer };

        peer.onIceCandidate((candidate) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'ice-candidate', candidate }));
          }
        });

        const onCaptureError = (err) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'capture-error', message: err.message || String(err) }));
          }
        };
        captureSource.on('error', onCaptureError);
        ws.once('close', () => captureSource.off('error', onCaptureError));

        ws.send(JSON.stringify({ type: 'auth-ok' }));
        return;
      }

      switch (msg.type) {
        case 'answer':
          await peer.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
          break;

        case 'ice-candidate':
          await peer.addIceCandidate(msg.candidate);
          break;

        case 'offer': {
          const answer = await peer.handleOffer(msg.sdp);
          ws.send(JSON.stringify({ type: 'answer', sdp: answer.sdp }));
          break;
        }

        case 'input':
          if (inputExecutor.isReady()) {
            try {
              const command = mapEventToCommand(msg.event);
              await inputExecutor.execute(command);
            } catch (err) {
              ws.send(JSON.stringify({ type: 'input-error', message: err.message }));
            }
          } else {
            ws.send(JSON.stringify({ type: 'input-error', message: 'ydotoold not running' }));
          }
          break;
      }
    });

    ws.on('close', () => {
      if (activeConn && activeConn.ws === ws) {
        peer && peer.close();
        activeConn = null;
      }
    });
  });

  return wss;
}

module.exports = { attachWsServer };
```

- [ ] **Step 2: Manual verification — scripted WS client**

Start a throwaway server for this test:
```
node -e "
const https = require('node:https');
const { getOrCreateCert } = require('./src/cert');
const { PairingManager } = require('./src/pairing');
const { CaptureSource } = require('./src/capture');
const { InputExecutor } = require('./src/inputExecutor');
const { attachWsServer } = require('./src/wsServer');

const { key, cert } = getOrCreateCert('/tmp/phone-remote-test-cert');
const server = https.createServer({ key, cert });
const pairingManager = new PairingManager();
const captureSource = new CaptureSource({ backend: 'wf-recorder', fps: 30 });
captureSource.start();
attachWsServer({ httpsServer: server, pairingManager, captureSource, inputExecutor: new InputExecutor() });
server.listen(8443, () => {
  const code = pairingManager.generateCode();
  console.log('code:', code, 'token:', (pairingManager.validateCode(code), pairingManager.getActiveToken()));
});
"
```
In a second terminal, connect with a WS client using the printed token (`npm install -g wscat` or use `node -e` with the `ws` package) to `wss://localhost:8443` (accept the self-signed cert, e.g. `wscat -n`), send `{"type":"auth","token":"<token>"}`, and confirm you receive `{"type":"auth-ok"}` followed by an `{"type":"offer",...}` message with a non-empty `sdp`.

Expected: `auth-ok` then `offer` received; connecting a second client with a fresh valid token causes the first client to receive `{"type":"kicked"}` and close.

- [ ] **Step 3: Manual verification — capture restart on next activity**

With the same throwaway server running and a client connected, run `pkill wf-recorder` in another terminal to kill the capture child. Then disconnect and reconnect the WS client with a fresh valid pairing code/token.
Expected: `captureSource.isRunning()` was `false` right after the kill; the new connection's `auth-ok`/`offer` flow succeeds and video frames resume, confirming `wsServer` restarted the capture child.

- [ ] **Step 4: Commit**

```bash
git add src/wsServer.js
git commit -m "feat: WS server with pairing auth, signaling, and input routing"
```

---

### Task 11: Express HTTPS server (entrypoint)

**Files:**
- Create: `server.js`

**Interfaces:**
- Consumes: everything from Tasks 2-10
- Produces: running server; `GET /` serves `public/index.html`; `GET /pair-qr` returns PNG; `POST /pair` `{code}` -> `{token}` or 401; prints LAN URL + code on startup

- [ ] **Step 1: Write the implementation**

```js
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
```

- [ ] **Step 2: Manual verification**

Run: `npm start`
Expected: prints the LAN HTTPS URL, session/backend info, and a warning if `ydotoold` isn't running. `curl -k https://<lan-ip>:8443/pair-qr -o /tmp/qr.png` produces a valid PNG (`file /tmp/qr.png` reports PNG image data). `curl -k -X POST https://<lan-ip>:8443/pair -H 'content-type: application/json' -d '{"code":"000000"}'` returns HTTP 401.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: Express+HTTPS entrypoint wiring pairing, capture, and WS"
```

---

### Task 12: PWA shell (manifest, service worker, page skeleton)

**Files:**
- Create: `public/manifest.json`
- Create: `public/sw.js`
- Create: `public/index.html`
- Create: `public/styles.css`

**Interfaces:**
- Produces: installable static shell; `public/app.js` (Task 13+) is loaded by `index.html` but not yet created — this task adds a placeholder `public/app.js` with just a `console.log('phone-remote loaded')` so the page doesn't 404.

- [ ] **Step 1: Write `public/manifest.json`**

```json
{
  "name": "Phone Remote",
  "short_name": "Remote",
  "start_url": "/",
  "display": "fullscreen",
  "orientation": "landscape",
  "background_color": "#000000",
  "theme_color": "#000000",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

Generate the two required icon files with `ffmpeg` (already a project dependency, no extra tooling needed):

```bash
ffmpeg -y -f lavfi -i color=c=#1a1a1a:s=192x192 -frames:v 1 public/icon-192.png
ffmpeg -y -f lavfi -i color=c=#1a1a1a:s=512x512 -frames:v 1 public/icon-512.png
```

These are solid-color placeholders sized correctly for `manifest.json`; swap in real artwork later if desired — without them Chrome's install prompt would show low-quality-icon warnings but still function.

- [ ] **Step 2: Write `public/sw.js`**

```js
const CACHE_NAME = 'phone-remote-shell-v1';
const SHELL_FILES = ['/', '/styles.css', '/app.js', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
```

- [ ] **Step 3: Write `public/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no" />
  <title>Phone Remote</title>
  <link rel="manifest" href="/manifest.json" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div id="pairing-screen">
    <h1>Phone Remote</h1>
    <button id="scan-btn">Scan QR to pair</button>
    <form id="code-form">
      <input id="code-input" inputmode="numeric" pattern="\d{6}" maxlength="6" placeholder="6-digit code" />
      <button type="submit">Connect</button>
    </form>
    <p id="pairing-error"></p>
  </div>

  <div id="remote-screen" hidden>
    <video id="remote-video" autoplay playsinline></video>
    <button id="drawer-toggle">⋮</button>
    <div id="drawer" hidden>
      <input id="keyboard-input" placeholder="Type here" />
      <div class="drawer-row">
        <button data-key="volumedown">Vol-</button>
        <button data-key="mute">Mute</button>
        <button data-key="volumeup">Vol+</button>
      </div>
      <div class="drawer-row">
        <button data-key="prev">⏮</button>
        <button data-key="playpause">⏯</button>
        <button data-key="next">⏭</button>
      </div>
      <button id="lock-btn">Lock Screen</button>
    </div>
  </div>

  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 4: Write `public/styles.css`**

```css
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; background: #000; color: #eee; font-family: system-ui, sans-serif; overflow: hidden; }
#pairing-screen { display: flex; flex-direction: column; gap: 1rem; align-items: center; justify-content: center; height: 100%; padding: 1rem; }
#code-input { font-size: 1.5rem; text-align: center; letter-spacing: 0.3rem; }
#pairing-error { color: #f66; min-height: 1.2rem; }
#remote-screen { position: relative; width: 100vw; height: 100vh; }
#remote-video { width: 100%; height: 100%; object-fit: contain; touch-action: none; background: #000; }
#drawer-toggle { position: absolute; top: 0.5rem; right: 0.5rem; z-index: 10; font-size: 1.5rem; background: rgba(0,0,0,0.5); color: #fff; border: none; border-radius: 50%; width: 2.5rem; height: 2.5rem; }
#drawer { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(20,20,20,0.95); padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem; }
.drawer-row { display: flex; gap: 0.5rem; justify-content: center; }
.drawer-row button { flex: 1; padding: 0.75rem; font-size: 1.1rem; }
#lock-btn { padding: 0.75rem; background: #a33; color: #fff; border: none; border-radius: 0.25rem; }
```

- [ ] **Step 5: Write placeholder `public/app.js`**

```js
console.log('phone-remote loaded');
```

- [ ] **Step 6: Manual verification**

Run: `npm start`, then on an Android phone on the same WiFi, open Chrome to `https://<lan-ip>:8443/`, accept the self-signed cert warning.
Expected: pairing screen renders (title, scan button, code form). Chrome's menu offers "Add to Home Screen" / "Install app". DevTools (`chrome://inspect` from a laptop Chrome, or remote debugging) shows the service worker registered and the manifest valid (no installability errors other than icon quality warnings).

- [ ] **Step 7: Commit**

```bash
git add public/manifest.json public/sw.js public/index.html public/styles.css public/app.js public/icon-192.png public/icon-512.png
git commit -m "feat: installable PWA shell"
```

---

### Task 13: PWA pairing flow (camera QR scan + code fallback)

**Files:**
- Modify: `public/app.js`

**Interfaces:**
- Consumes: `/pair` POST endpoint from Task 11
- Produces: on successful pairing, calls `onPaired(token)` (wired to Task 14's WS connection logic); persists token to `localStorage.getItem('phone-remote-token')`

- [ ] **Step 1: Replace `public/app.js` with the pairing module**

```js
const PAIRING = (() => {
  const TOKEN_KEY = 'phone-remote-token';

  function getStoredToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function storeToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
  }

  async function submitCode(code) {
    const res = await fetch('/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `pairing failed (${res.status})`);
    }
    const { token } = await res.json();
    storeToken(token);
    return token;
  }

  async function scanQrWithCamera() {
    if (!('BarcodeDetector' in window)) {
      throw new Error('QR scanning not supported on this browser');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();

    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    try {
      for (let i = 0; i < 100; i++) {
        const codes = await detector.detect(video);
        if (codes.length > 0) return codes[0].rawValue;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error('no QR code detected, try again');
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  }

  function extractCodeFromUrl(text) {
    try {
      const url = new URL(text);
      return url.searchParams.get('pair');
    } catch {
      return null;
    }
  }

  return { getStoredToken, storeToken, submitCode, scanQrWithCamera, extractCodeFromUrl };
})();

function initPairingUi(onPaired) {
  const errorEl = document.getElementById('pairing-error');
  const showError = (msg) => { errorEl.textContent = msg; };

  document.getElementById('code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = document.getElementById('code-input').value.trim();
    try {
      const token = await PAIRING.submitCode(code);
      onPaired(token);
    } catch (err) {
      showError(err.message);
    }
  });

  document.getElementById('scan-btn').addEventListener('click', async () => {
    try {
      const raw = await PAIRING.scanQrWithCamera();
      const code = PAIRING.extractCodeFromUrl(raw);
      if (!code) throw new Error('QR code did not contain a pairing code');
      const token = await PAIRING.submitCode(code);
      onPaired(token);
    } catch (err) {
      showError(err.message);
    }
  });
}

function showRemoteScreen() {
  document.getElementById('pairing-screen').hidden = true;
  document.getElementById('remote-screen').hidden = false;
}

const existingToken = PAIRING.getStoredToken();
if (existingToken) {
  showRemoteScreen();
  console.log('phone-remote: reusing stored token');
} else {
  initPairingUi((token) => {
    showRemoteScreen();
    console.log('phone-remote: paired, token stored');
  });
}
```

- [ ] **Step 2: Manual verification — code entry path**

On the phone, open the PWA, run `npm start` on the laptop, `curl -k https://<lan-ip>:8443/pair-qr -o /dev/null` once to print a fresh code to the laptop console, type that code into the phone's code field.
Expected: pairing screen hides, remote screen (empty video for now) shows. `localStorage` on the phone (check via remote DevTools) has `phone-remote-token` set.

- [ ] **Step 3: Manual verification — camera QR scan path**

Clear the phone's site data (to reset stored token), open the laptop terminal, visit `https://<lan-ip>:8443/pair-qr` in a laptop browser to display the QR, tap "Scan QR to pair" on the phone and point its camera at the laptop screen.
Expected: camera permission prompt appears once, QR is detected, pairing succeeds, remote screen shows.

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "feat: PWA pairing flow (camera QR scan + manual code)"
```

---

### Task 14: PWA WebRTC receive + video element

**Files:**
- Modify: `public/app.js`

**Interfaces:**
- Consumes: WS protocol from Task 10 (`auth`, `auth-ok`, `offer`, `answer`, `ice-candidate`)
- Produces: `connectRemote(token)` — opens the WS, completes signaling, attaches the received stream to `#remote-video`. Exposes the open WS instance as `REMOTE.ws` for Task 15/16 to send input events on.

- [ ] **Step 1: Add the WebRTC/WS module to `public/app.js`** (append before the final pairing bootstrap block, and change that block to call `connectRemote` instead of just `showRemoteScreen`)

```js
const REMOTE = (() => {
  let ws = null;
  let pc = null;

  function connect(token) {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(`wss://${location.host}/`);

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token }));
      });

      ws.addEventListener('message', async (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'auth-error' || msg.type === 'kicked') {
          reject(new Error(msg.type));
          return;
        }

        if (msg.type === 'auth-ok') {
          pc = new RTCPeerConnection({ iceServers: [] });
          pc.ontrack = (e) => {
            document.getElementById('remote-video').srcObject = e.streams[0];
          };
          pc.onicecandidate = (e) => {
            if (e.candidate) ws.send(JSON.stringify({ type: 'ice-candidate', candidate: e.candidate }));
          };
          pc.addTransceiver('video', { direction: 'recvonly' });
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
          return;
        }

        if (msg.type === 'answer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
          resolve();
          return;
        }

        if (msg.type === 'ice-candidate') {
          await pc.addIceCandidate(msg.candidate);
          return;
        }

        if (msg.type === 'capture-error') {
          console.error('capture error:', msg.message);
        }
      });

      ws.addEventListener('close', () => onDisconnect());
      ws.addEventListener('error', reject);
    });
  }

  function send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function onDisconnect() {
    console.log('phone-remote: disconnected');
  }

  return { connect, send };
})();
```

- [ ] **Step 2: Change the pairing bootstrap to call `REMOTE.connect`**

Replace the final block of `public/app.js` (the `existingToken` / `initPairingUi` block from Task 13) with:

```js
async function startRemote(token) {
  showRemoteScreen();
  try {
    await REMOTE.connect(token);
    console.log('phone-remote: video connected');
  } catch (err) {
    console.error('phone-remote: connect failed', err);
    localStorage.removeItem('phone-remote-token');
    location.reload();
  }
}

const existingToken = PAIRING.getStoredToken();
if (existingToken) {
  startRemote(existingToken);
} else {
  initPairingUi((token) => startRemote(token));
}
```

- [ ] **Step 3: Manual verification**

Pair the phone (Task 13 flow), leave it on the remote screen.
Expected: within ~1-2 seconds, `#remote-video` shows the laptop's live screen, motion visible when you move a window on the laptop. Browser console on the phone (via remote DevTools) logs `phone-remote: video connected`.

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "feat: PWA WebRTC signaling and live video receive"
```

---

### Task 15: PWA touch input handlers

**Files:**
- Modify: `public/app.js`

**Interfaces:**
- Consumes: `REMOTE.send` from Task 14
- Produces: touch gesture recognition on `#remote-video` sending `{type:'input', event}` messages matching Task 5's event shapes

- [ ] **Step 1: Add touch handling to `public/app.js`** (append at the end)

```js
function initTouchInput() {
  const video = document.getElementById('remote-video');
  let touches = [];
  let moved = false;
  const TAP_MAX_MOVE = 10;

  video.addEventListener('touchstart', (e) => {
    e.preventDefault();
    touches = Array.from(e.touches).map((t) => ({ id: t.identifier, x: t.clientX, y: t.clientY }));
    moved = false;
  }, { passive: false });

  video.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const current = Array.from(e.touches);
    if (touches.length === 0 || current.length === 0) return;

    if (touches.length === 1 && current.length === 1) {
      const dx = current[0].clientX - touches[0].x;
      const dy = current[0].clientY - touches[0].y;
      if (Math.abs(dx) > TAP_MAX_MOVE || Math.abs(dy) > TAP_MAX_MOVE) moved = true;
      REMOTE.send({ type: 'input', event: { type: 'move', dx: Math.round(dx), dy: Math.round(dy) } });
      touches = [{ id: current[0].identifier, x: current[0].clientX, y: current[0].clientY }];
    } else if (touches.length === 2 && current.length === 2) {
      const dy = current[0].clientY - touches[0].y;
      moved = true;
      REMOTE.send({ type: 'input', event: { type: 'scroll', dx: 0, dy: Math.round(dy) } });
      touches = current.map((t) => ({ id: t.identifier, x: t.clientX, y: t.clientY }));
    }
  }, { passive: false });

  video.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (!moved) {
      const button = touches.length === 2 ? 'right' : 'left';
      REMOTE.send({ type: 'input', event: { type: 'click', button } });
    }
    touches = [];
    moved = false;
  }, { passive: false });
}

initTouchInput();
```

- [ ] **Step 2: Manual verification**

On the paired phone, on the remote screen: one-finger drag should move the laptop cursor proportionally; a quick one-finger tap should left-click; a two-finger tap should right-click; a two-finger drag should scroll the focused window.
Expected: all five gestures produce the correct, visible effect on the laptop within a couple hundred milliseconds.

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat: touch-to-mouse input gestures"
```

---

### Task 16: PWA drawer UI (keyboard, media keys, lock)

**Files:**
- Modify: `public/app.js`

**Interfaces:**
- Consumes: `REMOTE.send` from Task 14
- Produces: drawer toggle, text-field-to-keystrokes, media key buttons, lock button, all wired to `{type:'input', event}` messages

- [ ] **Step 1: Add drawer handling to `public/app.js`** (append at the end)

```js
function initDrawer() {
  const toggle = document.getElementById('drawer-toggle');
  const drawer = document.getElementById('drawer');
  toggle.addEventListener('click', () => { drawer.hidden = !drawer.hidden; });

  const keyboardInput = document.getElementById('keyboard-input');
  keyboardInput.addEventListener('input', () => {
    const text = keyboardInput.value;
    if (text.length > 0) {
      REMOTE.send({ type: 'input', event: { type: 'type', text } });
      keyboardInput.value = '';
    }
  });

  document.querySelectorAll('#drawer button[data-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      REMOTE.send({ type: 'input', event: { type: 'key', name: btn.dataset.key } });
    });
  });

  document.getElementById('lock-btn').addEventListener('click', () => {
    REMOTE.send({ type: 'input', event: { type: 'lock' } });
  });
}

initDrawer();
```

- [ ] **Step 2: Manual verification**

Tap the drawer toggle (⋮), confirm the drawer slides up. Type in the keyboard field and confirm each character (sent on each `input` event) appears in the laptop's currently focused text field. Tap Vol+/Vol-/Mute and confirm system volume changes. Tap ⏮/⏯/⏭ with media playing and confirm playback responds. Tap "Lock Screen" and confirm the laptop locks.
Expected: all six controls produce the correct, visible effect on the laptop.

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat: drawer UI for keyboard, media keys, and lock"
```

---

### Task 17: Reconnect logic

**Files:**
- Modify: `public/app.js`

**Interfaces:**
- Consumes: `REMOTE` module from Task 14
- Produces: on unexpected WS close, retries `REMOTE.connect(token)` with backoff `[1000, 2000, 5000, 10000]` ms (capped), stops retrying only if the token itself is rejected (`auth-error`)

- [ ] **Step 1: Replace `REMOTE`'s `onDisconnect` and `startRemote` in `public/app.js`**

Change the `onDisconnect` function inside the `REMOTE` IIFE from:
```js
  function onDisconnect() {
    console.log('phone-remote: disconnected');
  }
```
to:
```js
  let reconnectCb = null;
  function onReconnectNeeded(cb) { reconnectCb = cb; }
  function onDisconnect() {
    console.log('phone-remote: disconnected');
    if (reconnectCb) reconnectCb();
  }
```
and change the module's final `return` line from:
```js
  return { connect, send };
```
to:
```js
  return { connect, send, onReconnectNeeded };
```

Then replace the `startRemote` function (from Task 14) with:

```js
const BACKOFF_STEPS_MS = [1000, 2000, 5000, 10000];

async function startRemote(token, attempt = 0) {
  showRemoteScreen();
  try {
    await REMOTE.connect(token);
    console.log('phone-remote: video connected');
    attempt = 0;
    REMOTE.onReconnectNeeded(() => {
      const delay = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)];
      console.log(`phone-remote: reconnecting in ${delay}ms`);
      setTimeout(() => startRemote(token, attempt + 1), delay);
    });
  } catch (err) {
    console.error('phone-remote: connect failed', err);
    if (String(err.message).includes('auth-error')) {
      localStorage.removeItem('phone-remote-token');
      location.reload();
      return;
    }
    const delay = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)];
    setTimeout(() => startRemote(token, attempt + 1), delay);
  }
}
```

- [ ] **Step 2: Manual verification**

With the phone paired and streaming, turn off the laptop's WiFi (or `Ctrl+C` the server) for ~15 seconds, then turn it back on / restart `npm start`.
Expected: phone console logs increasing backoff delays (`1000ms`, `2000ms`, `5000ms`, `10000ms`, then holds at `10000ms`), and the video stream resumes automatically once the server is reachable again, without re-showing the pairing screen.

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat: WS reconnect with capped backoff"
```

---

### Task 18: Error-handling polish + README

**Files:**
- Modify: `public/index.html` (add a banner element)
- Modify: `public/styles.css` (style the banner)
- Modify: `public/app.js` (show/hide the banner on `capture-error`/`input-error`, and on ydotoold-not-ready)
- Create: `README.md`

**Interfaces:**
- Produces: user-visible banner for capture failures and disabled-input state; complete setup/troubleshooting docs

- [ ] **Step 1: Add a banner element to `public/index.html`**

Add inside `<div id="remote-screen" hidden>`, just before `<video id="remote-video" ...>`:

```html
    <div id="banner" hidden></div>
```

- [ ] **Step 2: Style it in `public/styles.css`**

```css
#banner { position: absolute; top: 0; left: 0; right: 0; z-index: 20; background: #a33; color: #fff; text-align: center; padding: 0.5rem; font-size: 0.9rem; }
```

- [ ] **Step 3: Wire banner logic into `public/app.js`**

Add this function near the top (after the `PAIRING` module) and call it from the two relevant spots:

```js
function showBanner(text) {
  const el = document.getElementById('banner');
  el.textContent = text;
  el.hidden = false;
}
function hideBanner() {
  document.getElementById('banner').hidden = true;
}
```

In the `REMOTE` module's `message` handler, inside the `if (msg.type === 'capture-error')` branch, replace `console.error('capture error:', msg.message);` with:
```js
          showBanner(`Screen capture failed: ${msg.message}. Retrying...`);
```

Add a new branch right after it, inside the same handler:
```js
        if (msg.type === 'input-error') {
          showBanner(msg.message.includes('ydotoold')
            ? 'Input control unavailable: ydotoold is not running on the laptop.'
            : `Input error: ${msg.message}`);
          return;
        }
```

And in `startRemote`, right after `console.log('phone-remote: video connected');`, add:
```js
    hideBanner();
```

- [ ] **Step 4: Write `README.md`**

```markdown
# Phone Remote

Turn an Android phone into a low-latency wireless second screen + trackpad/keyboard
for a Linux laptop, over the same WiFi network.

## Requirements (laptop)

- Node.js 20+
- `ydotool` and `ydotoold` (input injection, works on both X11 and Wayland)
- Wayland/Hyprland (or another wlroots compositor): `wf-recorder`, and `hyprctl`
  available (ships with Hyprland)
- X11 (fallback): `ffmpeg` with `x11grab` support, `xdotool`

On Arch Linux:
```bash
sudo pacman -S ydotool wf-recorder ffmpeg xdotool
```

`ydotoold` needs access to `/dev/uinput`. Either run it as root, or add your user to
the relevant group and grant it access — see your distro's `ydotool` docs. Start it
before running the server:
```bash
sudo ydotoold &
```

## Install & run

```bash
npm install
npm start
```

The terminal prints the phone's connection URL (e.g. `https://192.168.1.50:8443/`)
and logs a fresh 6-digit pairing code whenever `/pair-qr` is requested.

## Pairing the phone

1. On your phone (same WiFi), open the printed URL in Chrome.
2. Accept the self-signed certificate warning (one-time; this is your own laptop's
   local server, not sent anywhere).
3. Either tap **Scan QR to pair** and point the camera at `https://<laptop-ip>:8443/pair-qr`
   opened in a browser on the laptop, or type the 6-digit code printed in the
   laptop's terminal.
4. Optionally tap Chrome's menu → **Add to Home Screen** to install it as a PWA.

The pairing token is stored on the phone; you won't need to re-pair unless the
server restarts or a second phone pairs (which disconnects the first).

## Troubleshooting

**"Screen capture failed" banner:**
- Wayland: confirm you're on a wlroots compositor (Hyprland, Sway, etc.) — GNOME/KDE
  are not supported in this version. Confirm `wf-recorder` and `hyprctl` are
  installed and `hyprctl monitors -j` returns your display.
- X11: confirm `ffmpeg -f x11grab -i :0 ...` works manually, and `$DISPLAY` is set
  for the process running `npm start`.

**"Input control unavailable: ydotoold is not running":**
- Run `sudo ydotoold &` before or after starting the server — the server will pick
  it up on the next input event.

**Video connects but there's no cursor movement / clicks:**
- Confirm `ydotoold`'s socket exists: `ls /tmp/.ydotool_socket`.
- Test manually: `YDOTOOL_SOCKET=/tmp/.ydotool_socket ydotool mousemove -- 50 0`
  should move the cursor.

**X11 vs Wayland is misdetected:**
- The server reads `$XDG_SESSION_TYPE`. Run `echo $XDG_SESSION_TYPE` in the same
  shell/session you launch `npm start` from — if it's empty or wrong, your display
  manager isn't setting it and you'll need to export it manually before `npm start`.

**Phone won't install as a PWA / service worker doesn't register:**
- The connection must be HTTPS (it is, via the self-signed cert) — plain HTTP won't
  register a service worker except on `localhost`. Make sure you didn't type `http://`
  instead of `https://`.

## Manual test checklist (no automated E2E — see spec)

- [ ] Pair via 6-digit code
- [ ] Pair via camera QR scan
- [ ] Live video visible, low latency, tracks laptop screen changes
- [ ] One-finger drag moves cursor; tap left-clicks; two-finger tap right-clicks;
      two-finger drag scrolls
- [ ] Drawer: keyboard field types into the focused laptop app
- [ ] Drawer: volume up/down/mute change laptop volume
- [ ] Drawer: play/pause/next/prev control media playback
- [ ] Drawer: lock button locks the laptop
- [ ] Turning laptop WiFi off/on triggers reconnect without re-pairing
- [ ] Restarting the server requires re-pairing (old token rejected)
- [ ] Pairing a second phone disconnects the first with a visible message
```

- [ ] **Step 5: Manual verification**

Trigger each error path once: stop `ydotoold` while connected and send an input event (banner should show the ydotoold message); kill the `wf-recorder`/`ffmpeg` child process manually (e.g. `pkill wf-recorder`) while connected (banner should show the capture-failed message).
Expected: both banners appear with the correct text and don't crash the app; normal operation resumes once the underlying issue is fixed and a new gesture/event is sent.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/styles.css public/app.js README.md
git commit -m "feat: error banners and README"
```
