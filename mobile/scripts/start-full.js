const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const venvPython311 = process.platform === 'win32'
  ? path.join(root, '.venv311', 'Scripts', 'python.exe')
  : path.join(root, '.venv311', 'bin', 'python');
const venvPython = process.platform === 'win32'
  ? path.join(root, '.venv', 'Scripts', 'python.exe')
  : path.join(root, '.venv', 'bin', 'python');
const python = fs.existsSync(venvPython311)
  ? venvPython311
  : fs.existsSync(venvPython) ? venvPython : (process.platform === 'win32' ? 'py' : 'python3');
const pythonArgs = python === 'py'
  ? ['-3', '-m', 'uvicorn', 'api:app', '--host', '0.0.0.0', '--port', '8000']
  : ['-m', 'uvicorn', 'api:app', '--host', '0.0.0.0', '--port', '8000'];
const processes = [];

function getLanAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

function start(command, args, cwd, label) {
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...(label === 'Expo' && getLanAddress() ? { EXPO_PUBLIC_API_URL: `http://${getLanAddress()}:8000` } : {}) },
  });
  child.on('error', (error) => console.error(`[${label}] ${error.message}`));
  processes.push(child);
}

start(python, pythonArgs, root, 'API');
console.log(`[API] Disponible para el telefono en http://${getLanAddress() ?? 'IP-DEL-PC'}:8000`);
start(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'start'], path.join(root, 'mobile'), 'Expo');

function stop() {
  for (const child of processes) {
    if (!child.killed) child.kill();
  }
}

process.on('SIGINT', () => {
  stop();
  process.exit(0);
});
process.on('SIGTERM', stop);
