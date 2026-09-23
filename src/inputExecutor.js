const fs = require('node:fs');
const { spawn } = require('node:child_process');

class InputExecutor {
  constructor({ ydotoolSocket = '/tmp/.ydotool_socket' } = {}) {
    this.ydotoolSocket = ydotoolSocket;
  }

  isReady() {
    return fs.existsSync(this.ydotoolSocket);
  }

  execute({ tool, args }) {
    return new Promise((resolve, reject) => {
      const env = tool === 'ydotool'
        ? { ...process.env, YDOTOOL_SOCKET: this.ydotoolSocket }
        : process.env;

      const child = spawn(tool, args, { env });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });

      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${tool} exited with code ${code}: ${stderr.trim()}`));
      });
    });
  }
}

module.exports = { InputExecutor };
