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


