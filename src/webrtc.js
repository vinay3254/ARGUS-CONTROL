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
