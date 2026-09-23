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
