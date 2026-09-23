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
