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
