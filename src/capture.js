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
        '-r', String(this.fps), '-f', 'pipe:1',
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
