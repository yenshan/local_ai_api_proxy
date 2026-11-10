const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { LocalServer } = require('../src/server.cjs');
const { normalize } = require('../src/protocol.cjs');
const { LogStore } = require('../src/store.cjs');
const { CodexRPC } = require('../src/rpc.cjs');

class FakeRPC extends EventEmitter {
  constructor() { super(); this.calls = []; this.counter = 0; this.hold = false; this.failTurn = false; }
  async start() {}
  stop() { this.emit('disconnected', new Error('stopped')); }
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'model/list') return params.cursor ? { data: [{ id: 'm2', model: 'model-two', displayName: 'Two', supportedReasoningEfforts: [], isDefault: false }], nextCursor: null } : { data: [{ id: 'm1', model: 'model-one', displayName: 'One', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], isDefault: true }], nextCursor: 'next' };
    if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'plus' } };
    if (method === 'thread/start') return { thread: { id: `thread-${++this.counter}` } };
    if (method === 'turn/start') {
      const threadId = params.threadId; const turn = { id: `turn-${threadId}`, status: 'inProgress' };
      const notify = (method, data) => this.emit('notification', { method, params: { threadId, ...data } });
      notify('turn/started', { turn });
      if (!this.hold) {
        // Deliberately send deltas and completion BEFORE resolving turn/start.
        const word = params.input[0].text.includes('second') ? 'second' : 'hello';
        notify('item/agentMessage/delta', { itemId: 'item-1', delta: word });
        notify('item/agentMessage/delta', { itemId: 'item-1', delta: ' world' });
        notify('item/completed', { item: { id: 'item-1', type: 'agentMessage', text: `${word} world` } });
        notify('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 12, inputTokens: 8, outputTokens: 4, cachedInputTokens: 2, reasoningOutputTokens: 1 } } });
        notify('turn/completed', { turn: { ...turn, status: this.failTurn ? 'failed' : 'completed', error: this.failTurn ? { message: 'upstream failed' } : null } });
      }
      return { turn };
    }
    return {};
  }
}
async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-api-test-'));
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const rpc = new FakeRPC(); const server = new LocalServer({ directory, rpcFactory: () => rpc }); server.configure({ port });
  await server.start();
  t.after(async () => { await server.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  const post = (body, endpoint = 'chat/completions', options = {}) => fetch(`${url}/v1/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options });
  return { server, rpc, url, post, directory };
}
const body = { messages: [{ role: 'user', content: 'hello' }] };
function parseSSE(text) { return text.split('\n\n').filter(s => s.includes('data: ') && !s.includes('[DONE]')).map(s => JSON.parse(s.split('\n').find(l => l.startsWith('data: ')).slice(6))); }

test('model catalog comes from paginated app-server and health works', async t => {
  const { url, rpc } = await setup(t);
  const response = await fetch(`${url}/v1/models`); const models = await response.json();
  assert.deepEqual(models.data.map(m => m.id), ['model-one','model-two']);
  assert.equal((await (await fetch(`${url}/health`)).json()).status, 'running');
  assert.equal(rpc.calls.filter(c => c.method === 'model/list').length, 4);
});
test('chat completion handles early notifications, no duplicate text, correct usage and logs', async t => {
  const { post, server, rpc } = await setup(t);
  const response = await post({ ...body, model: 'model-one', reasoning_effort: 'low' }); const json = await response.json();
  assert.equal(response.status, 200); assert.equal(json.choices[0].message.content, 'hello world'); assert.equal(json.usage.total_tokens, 12);
  assert.ok(response.headers.get('x-request-id')); assert.equal(server.store.list()[0].status, 'completed');
  const start = rpc.calls.find(c => c.method === 'thread/start'); assert.equal(start.params.ephemeral, true); assert.equal(start.params.sandbox, 'read-only');
  const turn = rpc.calls.find(c => c.method === 'turn/start'); assert.equal(turn.params.effort, 'low'); assert.equal(rpc.listenerCount('notification'), 0);
});
test('chat SSE has role, content, finish, usage and DONE', async t => {
  const { post } = await setup(t); const response = await post({ ...body, stream: true, stream_options: { include_usage: true } });
  const raw = await response.text(); const chunks = parseSSE(raw);
  assert.match(response.headers.get('content-type'), /event-stream/); assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks.slice(1,3).map(c => c.choices[0].delta.content).join(''), 'hello world'); assert.equal(chunks[3].choices[0].finish_reason, 'stop');
  assert.equal(chunks[4].usage.total_tokens, 12); assert.ok(raw.endsWith('data: [DONE]\n\n'));
});
test('Responses nonstream output and schema mapping', async t => {
  const { post, rpc } = await setup(t); const schema = { type: 'object', properties: { result: { type: 'string' } } };
  const response = await post({ input: 'hello', instructions: 'Be brief', text: { format: { type: 'json_schema', name: 'test', schema } } }, 'responses'); const json = await response.json();
  assert.equal(json.object, 'response'); assert.equal(json.status, 'completed'); assert.equal(json.output[0].content[0].text, 'hello world');
  assert.equal(json.usage.input_tokens, 8); assert.equal(rpc.calls.find(c => c.method === 'thread/start').params.developerInstructions, 'Be brief'); assert.deepEqual(rpc.calls.find(c => c.method === 'turn/start').params.outputSchema, schema);
});
test('Responses SSE event ordering, item ids and monotonic sequence numbers', async t => {
  const { post } = await setup(t); const chunks = parseSSE(await (await post({ input: 'hello', stream: true }, 'responses')).text());
  assert.deepEqual(chunks.map(c => c.type), ['response.created','response.in_progress','response.output_item.added','response.content_part.added','response.output_text.delta','response.output_text.delta','response.output_text.done','response.content_part.done','response.output_item.done','response.completed']);
  assert.deepEqual(chunks.map(c => c.sequence_number), chunks.map((_, i) => i));
  assert.equal(chunks[2].item.id, chunks[4].item_id); assert.equal(chunks.at(-1).response.status, 'completed');
});
test('parallel requests do not mix thread deltas', async t => {
  const { post } = await setup(t); const [a,b] = await Promise.all([post(body).then(r => r.json()),post({ messages: [{ role: 'user', content: 'second' }] }).then(r => r.json())]);
  assert.equal(a.choices[0].message.content, 'hello world'); assert.equal(b.choices[0].message.content, 'second world');
});
test('unknown model, unsupported parameters and non-text inputs fail explicitly', async t => {
  const { post, rpc } = await setup(t);
  for (const [request,status] of [[{ ...body, model: 'missing' },404],[{ ...body, tools: [] },400],[{ ...body, temperature: .7 },400],[{ ...body, max_tokens: 10 },400],[{ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] },400],[{ ...body, reasoning_effort: 'nope' },400],[{ ...body, stream: 'yes' },400]]) {
    const response = await post(request); assert.equal(response.status, status); assert.ok((await response.json()).error.message);
  }
  assert.equal(rpc.calls.filter(c => c.method === 'thread/start').length, 0);
});
test('invalid JSON, missing routes, browser origin, and forged host are rejected', async t => {
  const { post, url } = await setup(t);
  assert.equal((await post({},'chat/completions',{ body: '{' })).status, 400);
  assert.equal((await fetch(`${url}/v1/nope`)).status, 404);
  assert.equal((await post(body,'chat/completions',{ headers: { Origin: 'https://example.com' } })).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const request = http.request(`${url}/health`, { headers: { Host: 'example.com' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(forgedHostStatus, 403);
  const preflight = await fetch(`${url}/v1/chat/completions`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const localBrowser = await post(body, 'chat/completions', { headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' } });
  assert.equal(localBrowser.status, 200);
});
test('cancellation interrupts turn and cleans listeners', async t => {
  const { post, server, rpc } = await setup(t); rpc.hold = true;
  const response = await post({ ...body, stream: true }); const reading = response.text();
  await new Promise(resolve => setTimeout(resolve, 20)); const row = server.store.list()[0]; server.cancel(row.id);
  const text = await reading; assert.match(text, /Request cancelled/); assert.ok(!text.includes('[DONE]'));
  assert.ok(rpc.calls.some(c => c.method === 'turn/interrupt')); assert.equal(rpc.listenerCount('notification'), 0); assert.equal(row.status, 'cancelled');
});
test('timeout returns 504 and interrupts backend', async t => {
  const { post, server, rpc } = await setup(t); rpc.hold = true; server.settings.timeout = .03;
  const response = await post(body); assert.equal(response.status, 504); assert.match((await response.json()).error.message, /timed out/); assert.ok(rpc.calls.some(c => c.method === 'turn/interrupt'));
});
test('turn failure becomes HTTP error and SSE response.failed', async t => {
  const { post, rpc } = await setup(t); rpc.failTurn = true;
  const response = await post(body); assert.equal(response.status, 502);
  const raw = await (await post({ input: 'hello', stream: true }, 'responses')).text(); assert.match(raw, /event: response.failed/); assert.ok(!raw.includes('event: response.completed'));
});
test('backend disconnect settles pending generation', async t => {
  const { post, server, rpc } = await setup(t); rpc.hold = true;
  const response = await post({ ...body, stream: true }); const reading = response.text();
  rpc.emit('disconnected', new Error('lost backend')); assert.match(await reading, /lost backend/); assert.equal(server.state, 'error');
});
test('logs persist newest first, clear, rotate, and reject clear while running', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-log-test-'));
  try {
    let store = new LogStore(directory); store.persist({ id: 'old', status: 'completed' }); store.persist({ id: 'new', status: 'completed' });
    store = new LogStore(directory); assert.deepEqual(store.list().map(r => r.id), ['new','old']);
    store.add({ id: 'active', status: 'running' }); assert.throws(() => store.clear()); store.list()[0].status = 'completed'; store.clear(); assert.equal(store.list().length,0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('normalization preserves conversation as data and separates instructions', () => {
  const result = normalize({ messages: [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: [{ type: 'text', text: 'follow-up' }] }] }, 'chat');
  assert.equal(result.instructions, 'Rules'); assert.match(result.prompt, /follow-up/); assert.match(result.prompt, /"role":"assistant"/);
});
test('JSONL transport handles handshake, replies, notifications and unexpected exit', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rpc-test-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'fixture.cjs');
  fs.writeFileSync(script, `require('node:readline').createInterface({input:process.stdin}).on('line', l=>{const m=JSON.parse(l); if(m.method==='exit')process.exit(1); if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:{ok:m.method}})+'\\n'); if(m.method==='initialized')process.stdout.write(JSON.stringify({method:'ready',params:{}})+'\\n');});`);
  const rpc = new CodexRPC({ binary: process.execPath, commandArgs: [script], cwd: directory }); t.after(() => rpc.stop());
  const notified = new Promise(resolve => rpc.once('notification', resolve)); await rpc.start(); assert.equal((await notified).method,'ready'); assert.equal((await rpc.call('test')).ok,'test');
  await assert.rejects(rpc.call('exit'), /exited/); assert.equal(rpc.pending.size, 0);
});

test('official OpenAI JavaScript SDK consumes models, chat, and Responses streaming helper', async t => {
  const { default: OpenAI } = await import('openai');
  const { url } = await setup(t); const client = new OpenAI({ apiKey: 'local', baseURL: `${url}/v1`, maxRetries: 0 });
  const catalog = await client.models.list(); assert.equal(catalog.data[0].id, 'model-one');
  const reply = await client.chat.completions.create({ ...body, model: 'model-one' }); assert.equal(reply.choices[0].message.content, 'hello world');
  const stream = await client.chat.completions.create({ ...body, model: 'model-one', stream: true });
  let text = ''; for await (const chunk of stream) text += chunk.choices[0]?.delta?.content || ''; assert.equal(text, 'hello world');
  const response = await client.responses.create({ model: 'model-one', input: 'hello' }); assert.equal(response.output_text, 'hello world');
  const events = client.responses.stream({ model: 'model-one', input: 'hello' });
  const final = await events.finalResponse(); assert.equal(final.output_text, 'hello world'); assert.equal(final.status, 'completed');
});
