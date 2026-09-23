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
