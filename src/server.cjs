const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { CodexRPC } = require('./rpc.cjs');
const { AntigravityBackend } = require('./antigravity.cjs');
const { ClaudeBackend } = require('./claude.cjs');
const { LogStore } = require('./store.cjs');
const { APIError, normalize, chatUsage, responseObject } = require('./protocol.cjs');

const DEFAULTS = { port: 8787, backend: 'codex', antigravityBinary: '', claudeBinary: '', binary: '', timeout: 180 };
const HEALTH_NAMES = { codex: 'codex-app-server', antigravity: 'antigravity', claude: 'claude-code' };
const BASE = 'You are an assistant behind a local text-generation API. Answer directly. Do not inspect local files, run commands, browse the web, use skills, invoke tools, or perform actions. Only generate a reply to the supplied conversation.';

class LocalServer extends EventEmitter {
  constructor({ directory, rpcFactory, antigravityFactory, claudeFactory } = {}) {
    super(); this.directory = directory || path.resolve('.local-data');
    fs.mkdirSync(path.join(this.directory, 'workspace'), { recursive: true, mode: 0o700 });
    this.store = new LogStore(path.join(this.directory, 'logs'));
    this.rpcFactory = rpcFactory || (opts => new CodexRPC(opts));
    this.antigravityFactory = antigravityFactory || (opts => new AntigravityBackend(opts));
    this.claudeFactory = claudeFactory || (opts => new ClaudeBackend(opts));
    this.settings = { ...DEFAULTS }; this.models = []; this.state = 'stopped'; this.active = new Map(); this.diagnostics = [];
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(this.directory, 'settings.json')));
      for (const key of Object.keys(DEFAULTS)) if (saved[key] !== undefined) this.settings[key] = saved[key];
    } catch {}
    this.store.on('change', row => this.emit('log', row));
    this.store.on('reset', () => this.emit('reset'));
    this.store.on('storageError', message => { this.error = `Failed to save logs: ${message}`; this.emitState(); });
  }
  snapshot() { return { state: this.state, error: this.error, settings: this.settings, models: this.models, account: this.account, diagnostics: this.diagnostics, logDirectory: this.store.directory, baseURL: `http://127.0.0.1:${this.settings.port}/v1` }; }
  emitState() { this.emit('state', this.snapshot()); }
  validateSettings(settings) {
    const next = { ...this.settings };
    for (const key of Object.keys(DEFAULTS)) if (settings[key] !== undefined) next[key] = settings[key];
    next.port = Number(next.port); next.timeout = Number(next.timeout);
    if (!Number.isInteger(next.port) || next.port < 1024 || next.port > 65535) throw new Error('Port must be an integer between 1024 and 65535.');
    if (!Number.isFinite(next.timeout) || next.timeout < 10 || next.timeout > 3600) throw new Error('Timeout must be between 10 and 3600 seconds.');
    if (!Object.keys(HEALTH_NAMES).includes(next.backend)) throw new Error('Invalid backend');
    for (const key of ['binary', 'antigravityBinary', 'claudeBinary']) if (typeof next[key] !== 'string') throw new Error(`Invalid ${key}`);
    return next;
  }
  commitSettings(next) {
    fs.writeFileSync(path.join(this.directory, 'settings.json'), JSON.stringify(next, null, 2), { mode: 0o600 });
    if (next.backend !== this.settings.backend) { this.models = []; this.account = null; }
    this.settings = next;
    this.emitState(); return this.snapshot();
  }
  configure(settings) {
    if (this.state !== 'stopped' && this.state !== 'error') throw new Error('Stop the server before changing settings.');
    return this.commitSettings(this.validateSettings(settings));
  }
  applySettings(settings) {
    if (!['stopped', 'error'].includes(this.state)) return Promise.reject(new Error('Stop the server before changing settings.'));
    this.settingsUpdate = (this.settingsUpdate || Promise.resolve()).catch(() => {}).then(() => this.configure(settings));
    return this.settingsUpdate;
  }
  async start() {
    if (this.state === 'running') return this.snapshot();
    if (this.state === 'starting' || this.state === 'stopping') throw new Error('The server is starting or stopping.');
    if (this.rpc || this.http) await this.stop();
    this.state = 'starting'; this.models = []; this.account = null; this.requiresLogin = false; this.error = null; this.emitState();
    try {
      const cwd = path.join(this.directory, 'workspace'); const { backend } = this.settings;
      this.rpc = backend === 'antigravity' ? this.antigravityFactory({ binary: this.settings.antigravityBinary, cwd })
        : backend === 'claude' ? this.claudeFactory({ binary: this.settings.claudeBinary, cwd })
        : this.rpcFactory({ binary: this.settings.binary, cwd });
      this.rpc.on('diagnostic', message => { this.diagnostics.push({ time: new Date().toISOString(), message: message.slice(0, 8000) }); this.diagnostics = this.diagnostics.slice(-80); this.emit('diagnostic', this.diagnostics.at(-1)); });
      this.rpc.on('disconnected', err => {
        for (const controller of this.active.values()) controller.abort(err);
        if (this.state === 'running' || this.state === 'starting') { this.error = err.message; this.state = 'error'; this.emitState(); }
      });
      await this.rpc.start();
      // Disable inherited connectors for generation threads without changing
      // the user's Codex configuration or exposing its values in logs.
      if (this.settings.backend === 'codex') {
        const config = await this.rpc.call('config/read', { includeLayers: false });
        this.threadConfig = { 'features.shell_tool': false, 'features.apps': false, web_search: 'disabled' };
        for (const name of Object.keys(config.config?.mcp_servers || {})) this.threadConfig[`mcp_servers.${name}.enabled`] = false;
        const account = await this.rpc.call('account/read', { refreshToken: false });
        this.account = account.account ? { type: account.account.type, planType: account.account.planType } : null;
        this.requiresLogin = account.requiresOpenaiAuth && !account.account;
        if (this.requiresLogin) this.error = 'Codex is not signed in. Run codex login in a terminal, then restart the server.';
      } else {
        this.account = { type: this.settings.backend === 'claude' ? 'Claude Code' : 'Antigravity CLI' };
      }
      await this.refreshModels();
      this.http = http.createServer((req, res) => this.handle(req, res));
      this.http.requestTimeout = 15000; this.http.headersTimeout = 10000;
      await new Promise((resolve, reject) => {
        this.http.once('error', reject);
        this.http.listen(this.settings.port, '127.0.0.1', () => { this.http.removeListener('error', reject); resolve(); });
      });
      this.state = 'running'; this.emitState(); return this.snapshot();
    } catch (err) {
      this.rpc?.stop(); this.rpc = null; this.http?.close(); this.http = null;
      this.state = 'error'; this.error = err.message; this.emitState(); throw err;
    }
  }
  async refreshModels() {
    const rpc = this.rpc; const backend = this.settings.backend;
    if (!rpc) throw new Error('Start the server first.');
    if (backend !== 'codex') {
      const models = await rpc.listModels();
      if (this.rpc !== rpc || this.settings.backend !== backend) return this.models;
      this.models = models; this.emitState(); return models;
    }
    const models = []; let cursor = null; const seen = new Set();
    do {
      const page = await rpc.call('model/list', { limit: 100, cursor, includeHidden: false });
      models.push(...page.data); cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('model/list returned a repeated cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (this.rpc !== rpc || this.settings.backend !== backend) return this.models;
    this.models = models; this.emitState(); return models;
  }
  async stop() {
    this.state = 'stopping'; this.emitState();
    for (const controller of this.active.values()) controller.abort(new Error('Server stopped'));
    const server = this.http; this.http = null;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    this.rpc?.stop(); this.rpc = null; this.state = 'stopped'; this.emitState(); return this.snapshot();
  }
  cancel(id) { this.active.get(id)?.abort(new Error('Request cancelled')); }
  async handle(req, res) {
    const started = Date.now();
    const row = { id: randomUUID(), time: new Date().toISOString(), method: req.method, path: req.url, status: 'running', backend: this.settings.backend, events: [], text: '', request: null, response: null, stream: false };
    this.store.add(row);
    const controller = new AbortController(); this.active.set(row.id, controller);
    res.setHeader('x-request-id', row.id);
    res.on('close', () => { if (!res.writableEnded) controller.abort(new Error('Client disconnected')); });
    let heartbeat; let sequence = 0; let context; let kind;
    const sendJSON = (status, value) => { if (res.destroyed) return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    const event = (name, value) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.writableLength > 4 * 1024 * 1024) { controller.abort(new Error('Streaming client is too slow')); return; }
      if (name) res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, sequence_number: sequence++, ...value })}\n\n`);
      else res.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
    };
    try {
      // Local API only. Browser origins and non-loopback Host headers are rejected.
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) throw new APIError('Only local API clients are allowed', 403);
      if (req.headers.origin) {
        let origin; try { origin = new URL(req.headers.origin); } catch { throw new APIError('Invalid origin', 403); }
        if (!['http:','https:'].includes(origin.protocol) || !['127.0.0.1','localhost'].includes(origin.hostname)) throw new APIError('Only localhost browser origins are allowed', 403);
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, OpenAI-Organization, OpenAI-Project, X-Stainless-Lang, X-Stainless-Package-Version, X-Stainless-OS, X-Stainless-Arch, X-Stainless-Runtime, X-Stainless-Runtime-Version, X-Stainless-Retry-Count, X-Stainless-Timeout, X-Stainless-Helper-Method');
        res.setHeader('Access-Control-Expose-Headers', 'x-request-id');
      }
      const route = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'OPTIONS') {
        res.writeHead(204); res.end();
      } else if (req.method === 'GET' && route === '/health') {
        row.response = { status: this.state, backend: HEALTH_NAMES[this.settings.backend] }; sendJSON(this.state === 'running' ? 200 : 503, row.response);
      } else if (req.method === 'GET' && route === '/v1/models') {
        if (this.state !== 'running') throw new APIError('AI backend is unavailable', 503, null, 'server_error');
        await this.refreshModels();
        row.response = { object: 'list', data: this.models.map(m => ({ id: m.model, object: 'model', created: 0, owned_by: this.settings.backend, name: m.displayName })) };
        sendJSON(200, row.response);
      } else if (req.method === 'POST' && ['/v1/chat/completions', '/v1/responses'].includes(route)) {
        if (this.state !== 'running') throw new APIError('AI backend is unavailable', 503, null, 'server_error');
        if (this.active.size > 16) throw new APIError('Too many concurrent requests', 429, null, 'rate_limit_exceeded');
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new APIError('Request body exceeds 2 MiB', 413); chunks.push(chunk); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new APIError('Invalid JSON body'); }
        this.store.update(row, { request: body });
        kind = route.endsWith('/responses') ? 'responses' : 'chat';
        const input = normalize(body, kind);
        const model = body.model || this.models.find(m => m.isDefault)?.model || this.models[0]?.model;
        const entry = this.models.find(m => m.model === model || m.id === model);
        if (!entry) throw new APIError(`Unknown model: ${model}. Query GET /v1/models.`, 404, 'model', 'model_not_found');
        const effort = input.effort || undefined;
        if (effort && !entry.supportedReasoningEfforts.some(e => e.reasoningEffort === effort)) throw new APIError(`Unsupported reasoning effort: ${effort}`, 400, 'reasoning_effort');
        this.store.update(row, { model: entry.model, stream: input.stream });
        context = { id: `${kind === 'chat' ? 'chatcmpl' : 'resp'}_${row.id.replaceAll('-', '')}`, itemId: `msg_${row.id.replaceAll('-', '')}`, model: entry.model, created: Math.floor(started / 1000), body };
        const chunk = (delta, finish_reason = null) => ({ id: context.id, object: 'chat.completion.chunk', created: context.created, model: context.model, choices: [{ index: 0, delta, finish_reason }] });
        let openedItem = false;
        const openItem = () => {
          if (openedItem) return; openedItem = true;
          event('response.output_item.added', { output_index: 0, item: { id: context.itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
          event('response.content_part.added', { item_id: context.itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
        };
        if (input.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.flushHeaders(); heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 10000);
          if (kind === 'chat') event(null, chunk({ role: 'assistant', content: '' }));
          else { const response = responseObject({ ...context, status: 'in_progress' }); event('response.created', { response }); event('response.in_progress', { response }); }
        }
        const result = await this.generate(row, input, context.model, effort, controller.signal, delta => {
          if (!input.stream) return;
          if (kind === 'chat') event(null, chunk({ content: delta }));
          else { openItem(); event('response.output_text.delta', { item_id: context.itemId, output_index: 0, content_index: 0, delta, logprobs: [] }); }
        });
        context.text = result.text; context.usage = result.usage;
        row.response = kind === 'chat' ? { id: context.id, object: 'chat.completion', created: context.created, model: context.model,
          choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop', logprobs: null }], usage: chatUsage(result.usage) } : responseObject(context);
        if (input.stream) {
          if (kind === 'chat') {
            event(null, chunk({}, 'stop'));
            if (body.stream_options?.include_usage) event(null, { ...chunk({}), choices: [], usage: chatUsage(result.usage) });
            event(null, '[DONE]');
          } else {
            openItem();
            event('response.output_text.done', { item_id: context.itemId, output_index: 0, content_index: 0, text: result.text, logprobs: [] });
            event('response.content_part.done', { item_id: context.itemId, output_index: 0, content_index: 0, part: row.response.output[0].content[0] });
            event('response.output_item.done', { output_index: 0, item: row.response.output[0] });
            event('response.completed', { response: row.response });
          }
          res.end();
        } else sendJSON(200, row.response);
      } else throw new APIError('Endpoint not found', 404, null, 'not_found');
      this.store.update(row, { status: 'completed', httpStatus: req.method === 'OPTIONS' ? 204 : 200 });
    } catch (err) {
      const status = err.status || (controller.signal.aborted ? 499 : 502);
      const error = { message: err.message, type: status < 500 ? 'invalid_request_error' : 'server_error', param: err.param || null, code: err.code || 'backend_error' };
      if (res.headersSent) {
        if (kind === 'responses' && context) event('response.failed', { response: responseObject({ ...context, text: row.text, status: 'failed', error: { code: 'server_error', message: err.message } }) });
        else event(null, { error });
        res.end();
      } else sendJSON(status, { error });
      this.store.update(row, { status: controller.signal.aborted ? 'cancelled' : 'error', error: err.message, httpStatus: res.headersSent && row.stream ? 200 : status, response: { error } });
    } finally {
      clearInterval(heartbeat); this.active.delete(row.id);
      this.store.update(row, { duration: Date.now() - started }); this.store.persist(row);
    }
  }
  async generate(row, input, model, effort, signal, onDelta) {
    const rpc = this.rpc;
    if (this.settings.backend !== 'codex') {
      const result = await rpc.generate({ input, model, effort, signal, timeout: this.settings.timeout * 1000, baseInstructions: BASE,
        onDelta: delta => { this.store.update(row, { text: row.text + delta }); onDelta(delta); },
        onThread: threadId => this.store.update(row, { threadId }),
        onEvent: event => { if (row.events.length < 1000) row.events.push({ time: new Date().toISOString(), ...event }); else row.eventsTruncated = true; } });
      this.store.update(row, { usage: result.usage }); return result;
    }
    let threadId; let turnId; let usage; let text = ''; let settled = false; let listener; let abort; let timer;
    const streamed = new Set();
    const append = delta => { text += delta; this.store.update(row, { text }); onDelta(delta); };
    // Attach notification handling before turn/start: notifications may arrive before its reply.
    try {
      if (signal.aborted) throw signal.reason;
      const thread = await rpc.call('thread/start', { model, cwd: path.join(this.directory, 'workspace'), approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, config: this.threadConfig, baseInstructions: BASE, developerInstructions: input.instructions || null });
      threadId = thread.thread.id; this.store.update(row, { threadId });
      return await new Promise((resolve, reject) => {
        const finish = (err) => { if (settled) return; settled = true; if (err) reject(err); else resolve({ text, usage }); };
        const interrupt = () => { if (turnId) rpc.call('turn/interrupt', { threadId, turnId }).catch(() => {}); };
        abort = () => { interrupt(); finish(signal.reason || new Error('Request cancelled')); };
        listener = msg => {
          const p = msg.params || {}; if (p.threadId !== threadId) return;
          if (row.events.length < 1000) row.events.push({ time: new Date().toISOString(), method: msg.method, params: p }); else row.eventsTruncated = true;
          if (p.turn?.id) turnId = p.turn.id;
          if (msg.method === 'thread/tokenUsage/updated') usage = p.tokenUsage?.last;
          if (msg.method === 'item/agentMessage/delta') { streamed.add(p.itemId); append(p.delta); }
          if (msg.method === 'item/completed' && p.item?.type === 'agentMessage' && !streamed.has(p.item.id)) append(p.item.text || '');
          if (msg.method === 'turn/completed') {
            this.store.update(row, { usage });
            finish(p.turn.status === 'completed' ? null : new Error(p.turn.error?.message || `Codex turn ${p.turn.status}`));
          }
        };
        rpc.on('notification', listener); signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => { interrupt(); finish(new APIError('Generation timed out', 504, null, 'timeout')); }, this.settings.timeout * 1000);
        if (signal.aborted) { abort(); return; }
        rpc.call('turn/start', { threadId, input: [{ type: 'text', text: input.prompt, text_elements: [] }], ...(effort ? { effort } : {}), ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}) }).then(result => {
          turnId = result.turn.id;
          if (settled || signal.aborted) interrupt();
        }).catch(finish);
      });
    } finally {
      clearTimeout(timer); if (listener) rpc.off('notification', listener); if (abort) signal.removeEventListener('abort', abort);
      if (threadId) rpc.call('thread/unsubscribe', { threadId }).catch(() => {});
    }
  }
}
module.exports = { LocalServer, DEFAULTS };
