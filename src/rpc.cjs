const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');

function findCodex(configured) {
  if (configured) return configured;
  for (const candidate of ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/Applications/Codex.app/Contents/Resources/codex']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'codex';
}

class CodexRPC extends EventEmitter {
  constructor({ binary, cwd, commandArgs } = {}) {
    super(); this.binary = findCodex(binary); this.cwd = cwd; this.commandArgs = commandArgs;
    this.pending = new Map(); this.sequence = 0; this.setMaxListeners(100);
  }
  async start() {
    const args = this.commandArgs || ['app-server', '--listen', 'stdio://', '-c', 'features.shell_tool=false', '-c', 'web_search="disabled"'];
    this.child = spawn(this.binary, args, {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` },
    });
    this.child.on('error', err => this.fail(err));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Codex app-server exited (${code ?? signal})`)));
    this.child.stdin.on('error', err => this.fail(err));
    this.child.stderr.on('data', data => this.emit('diagnostic', data.toString()));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { this.emit('diagnostic', line); return; }
      if (msg.id !== undefined && !msg.method) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id); clearTimeout(pending.timer);
          if (msg.error) pending.reject(new Error(msg.error.message)); else pending.resolve(msg.result);
        }
      } else if (msg.id !== undefined) {
        // API clients cannot approve agent actions or respond to interactive questions.
        this.emit('notification', { method: 'bridge/interactiveRequestRejected', params: { method: msg.method } });
        if (/requestApproval/.test(msg.method)) this.send({ id: msg.id, result: { decision: 'decline' } });
        else this.send({ id: msg.id, error: { code: -32601, message: 'Interactive tools are unavailable in the local API bridge' } });
      } else this.emit('notification', msg);
    });
    await this.call('initialize', { clientInfo: { name: 'codex_local_api', title: 'Local AI API Proxy', version: '1.0.0' } });
    this.send({ method: 'initialized', params: {} });
  }
  send(message) {
    if (!this.child || this.child.killed || this.child.stdin.destroyed) throw new Error('Codex app-server is not connected');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method, params = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }
  fail(err) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear(); this.emit('disconnected', err);
  }
  stop() { this.lines?.close(); this.child?.kill(); this.fail(new Error('Server stopped')); }
}
module.exports = { CodexRPC, findCodex };
