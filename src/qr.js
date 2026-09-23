const QRCode = require('qrcode');

function generatePairingQr(url) {
  return QRCode.toBuffer(url, { type: 'png', errorCorrectionLevel: 'M', margin: 2 });
}

module.exports = { generatePairingQr };
