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
