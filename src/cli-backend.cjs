const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { APIError } = require('./protocol.cjs');

function findExecutable(configured, candidates, fallback) {
  if (configured) return configured;
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return fallback;
}
// Runs one CLI process per call. With onEvent, stdout is parsed as NDJSON;
// otherwise stdout is returned as text.
class CLIBackend extends EventEmitter {
  constructor({ binary, cwd, label, hint, env = {} }) {
    super(); Object.assign(this, { binary, cwd, label, hint, extraEnv: env }); this.jobs = new Set(); this.stopped = false;
  }
  async start() { this.stopped = false; }
  environment() {
    const env = { ...process.env, NO_COLOR: '1', PATH: `${process.env.PATH || ''}:${path.join(os.homedir(), '.local/bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, ...this.extraEnv };
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
    return env;
  }
  run(args, { cwd = this.cwd, input = '', signal, timeout = 30000, onEvent } = {}) {
    const name = this.label;
    if (this.stopped) return Promise.reject(new Error(`${name} is stopped`));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: this.environment() });
      let stdout = ''; let stderr = ''; let buffer = ''; let settled = false; let killTimer;
      const kill = () => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1500); killTimer.unref(); };
      const finish = (err) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        this.jobs.delete(cancel);
        if (err) { kill(); reject(err); } else resolve(stdout);
      };
      const cancel = () => finish(new Error('Server stopped'));
      const abort = () => finish(signal.reason || new Error('Request cancelled'));
      const timer = setTimeout(() => finish(new APIError(`${name} timed out`, 504, null, 'timeout')), timeout);
      this.jobs.add(cancel); signal?.addEventListener('abort', abort, { once: true });
      child.on('error', err => finish(new Error(`${name}: ${err.message}. Check the CLI installation and executable path.`)));
      child.stdin.on('error', err => { if (err.code !== 'EPIPE') finish(err); });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8000); });
      const line = value => { if (!value.trim()) return; let event; try { event = JSON.parse(value); } catch { throw new Error(`Invalid ${name} stream JSON`); } onEvent(event); };
      child.stdout.on('data', data => {
        if (settled) return;
        try {
          if (onEvent) {
            buffer += data.toString();
            if (buffer.length > 8 * 1024 * 1024) throw new Error(`${name} event exceeds 8 MiB`);
            let end; while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
          } else { stdout += data.toString(); if (stdout.length > 2 * 1024 * 1024) throw new Error(`${name} output exceeds 2 MiB`); }
        } catch (err) { finish(err); }
      });
      child.on('close', code => {
        clearTimeout(killTimer);
        if (settled) return;
        try { if (onEvent && buffer.trim()) line(buffer); } catch (err) { finish(err); return; }
        finish(code === 0 ? null : new Error(`${name} exited (${code}): ${stderr || this.hint}`));
      });
      child.stdin.end(input);
      if (signal?.aborted) abort();
    });
  }
  // A private working directory per generation, removed afterwards.
  async withDirectory(prefix, fn) {
    const directory = fs.mkdtempSync(path.join(this.cwd, prefix));
    try { return await fn(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
  stop() { this.stopped = true; for (const cancel of [...this.jobs]) cancel(); }
}
module.exports = { CLIBackend, findExecutable };
