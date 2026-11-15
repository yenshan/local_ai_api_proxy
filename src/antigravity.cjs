const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { APIError } = require('./protocol.cjs');

const AGENT = 'local-api-text';
function findAntigravity(configured) {
  if (configured) return configured;
  for (const candidate of [path.join(os.homedir(), '.local/bin/agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'agy';
}
function parseModels(output) {
  const models = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([a-z0-9][a-z0-9._-]*)[\t ]+(.+)$/);
    if (match && !models.some(m => m.model === match[1])) models.push({ id: match[1], model: match[1], displayName: match[2].trim(), supportedReasoningEfforts: [], isDefault: false });
  }
  if (!models.length) throw new Error('Antigravity のモデル一覧を取得できませんでした。agy にログインしているか確認してください。');
  models[0].isDefault = true;
  return models;
}
class AntigravityBackend extends EventEmitter {
  constructor({ binary, cwd } = {}) {
    super(); this.binary = findAntigravity(binary); this.cwd = cwd; this.jobs = new Set(); this.stopped = false;
  }
  async start() { this.stopped = false; }
  run(args, { cwd = this.cwd, input = '', signal, timeout = 30000, onEvent } = {}) {
    if (this.stopped) return Promise.reject(new Error('Antigravity is stopped'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', PATH: `${process.env.PATH || ''}:${path.join(os.homedir(), '.local/bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` } });
      let stdout = ''; let stderr = ''; let buffer = ''; let settled = false; let killTimer;
      const kill = () => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1500); killTimer.unref(); };
      const finish = (err) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        this.jobs.delete(cancel);
        if (err) { kill(); reject(err); } else resolve(stdout);
      };
      const cancel = () => finish(new Error('Server stopped'));
      const abort = () => finish(signal.reason || new Error('Request cancelled'));
      const timer = setTimeout(() => finish(new APIError('Antigravity timed out', 504, null, 'timeout')), timeout);
      this.jobs.add(cancel); signal?.addEventListener('abort', abort, { once: true });
      child.on('error', err => finish(new Error(`Antigravity: ${err.message}. agy のインストールと実行ファイル設定を確認してください。`)));
      child.stdin.on('error', err => { if (err.code !== 'EPIPE') finish(err); });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8000); });
      const line = value => { if (!value.trim()) return; let event; try { event = JSON.parse(value); } catch { throw new Error('Invalid Antigravity stream JSON'); } onEvent(event); };
      child.stdout.on('data', data => {
        if (settled) return;
        try {
          if (onEvent) {
            buffer += data.toString();
            if (buffer.length > 8 * 1024 * 1024) throw new Error('Antigravity event exceeds 8 MiB');
            let end; while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
          } else { stdout += data.toString(); if (stdout.length > 2 * 1024 * 1024) throw new Error('Antigravity output exceeds 2 MiB'); }
        } catch (err) { finish(err); }
      });
      child.on('close', code => {
        clearTimeout(killTimer);
        if (settled) return;
        try { if (onEvent && buffer.trim()) line(buffer); } catch (err) { finish(err); return; }
        finish(code === 0 ? null : new Error(`Antigravity exited (${code}): ${stderr || 'agy でログインしてから再試行してください。'}`));
      });
      child.stdin.end(input);
      if (signal?.aborted) abort();
    });
  }
  async listModels() { return parseModels(await this.run(['models'])); }
  async generate({ input, model, signal, timeout, baseInstructions, onDelta, onEvent, onThread }) {
    const directory = fs.mkdtempSync(path.join(this.cwd, 'antigravity-'));
    try {
      fs.mkdirSync(path.join(directory, '.git'));
      const agents = path.join(directory, '.agents', 'agents'); fs.mkdirSync(agents, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(agents, `${AGENT}.md`), `---\nname: ${AGENT}\ndescription: Text generation for the local API\nmainAgent: true\nsubagent: false\ntools: [finish]\nenabledTools: [finish]\nmcpServers: []\nskills: []\nplugins: []\ncommandExecutionPolicy: off\n---\n${baseInstructions}\n\n${input.instructions || ''}\n`, { mode: 0o600 });
      const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--agent', AGENT, '--model', model];
      if (input.outputSchema) args.push('--json-schema', JSON.stringify(input.outputSchema));
      let text = ''; let result;
      const append = delta => { text += delta; onDelta(delta); };
      await this.run(args, { cwd: directory, signal, timeout, input: JSON.stringify({ event: 'user', message: { content: input.prompt } }) + '\n', onEvent: event => {
        onEvent(event);
        if (event.event === 'init') {
          onThread(event.conversation_id);
          if (event.init?.agent !== AGENT) throw new Error('Antigravity did not select the local API agent');
        }
        if (event.event === 'step_update' && event.step_update?.step_type === 'agent_response' && typeof event.step_update.text_delta === 'string' && !input.outputSchema) append(event.step_update.text_delta);
        if (event.event === 'result') result = event.result;
      } });
      if (signal.aborted) throw signal.reason;
      if (!result || result.status !== 'SUCCESS') throw new Error(result?.error || `Antigravity ${result?.status || 'returned no result'}`);
      const finalText = input.outputSchema && result.structured_output !== undefined ? JSON.stringify(result.structured_output) : result.response;
      if (typeof finalText !== 'string') throw new Error('Antigravity returned no response text');
      if (input.outputSchema) append(finalText);
      else if (finalText.startsWith(text)) append(finalText.slice(text.length));
      else if (finalText !== text) throw new Error('Antigravity result differs from streamed text');
      const u = result.usage;
      const usage = u ? { inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, totalTokens: u.total_tokens ?? ((u.input_tokens || 0) + (u.output_tokens || 0)), cachedInputTokens: u.cache_read_tokens || 0, reasoningOutputTokens: u.thinking_tokens || 0 } : undefined;
      return { text, usage };
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
  stop() { this.stopped = true; for (const cancel of [...this.jobs]) cancel(); }
}
module.exports = { AntigravityBackend, findAntigravity, parseModels };
