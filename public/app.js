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
