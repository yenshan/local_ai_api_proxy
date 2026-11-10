const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

class LogStore extends EventEmitter {
  constructor(directory) {
    super(); this.directory = directory; this.rows = []; this.writeError = null;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'requests.jsonl');
    if (fs.existsSync(this.file)) {
      const stat = fs.statSync(this.file);
      const length = Math.min(stat.size, 8 * 1024 * 1024);
      const fd = fs.openSync(this.file, 'r'); const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, stat.size - length); fs.closeSync(fd);
      const lines = buffer.toString('utf8').split('\n');
      for (const line of lines) { try { const row = JSON.parse(line); if (row.status === 'running') { row.status = 'interrupted'; row.error = 'アプリ終了により中断されました'; } this.rows.push(row); } catch {} }
      this.rows = this.rows.slice(-300).reverse();
    }
  }
  add(row) { this.rows.unshift(row); this.rows = this.rows.slice(0, 300); this.emit('change', row); }
  update(row, patch) { Object.assign(row, patch); this.emit('change', row); }
  persist(row) {
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > 20 * 1024 * 1024) fs.renameSync(this.file, this.file + '.1');
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch (err) { this.writeError = err.message; this.emit('storageError', err.message); }
  }
  list() { return this.rows; }
  clear() { if (this.rows.some(r => r.status === 'running')) throw new Error('実行中のリクエストがあります'); this.rows = []; for (const f of [this.file, this.file + '.1']) fs.rmSync(f, { force: true }); this.emit('reset'); }
}
module.exports = { LogStore };
