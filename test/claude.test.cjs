const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { LocalServer } = require('../src/server.cjs');

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-'));
  const binary = path.join(directory, 'claude');
  fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(); }
const flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
if (flag('--tools') !== '' || !args.includes('--strict-mcp-config') || !args.includes('--no-session-persistence') || process.env.CLAUDECODE) process.exit(3);
if (!flag('--system-prompt').includes('Only generate a reply')) process.exit(4);
fs.writeFileSync(${JSON.stringify(path.join(directory, 'last-args.json'))}, JSON.stringify(args));
let prompt=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d=>prompt+=d);
process.stdin.on('end', ()=> {
 const send = e => console.log(JSON.stringify(e));
 send({type:'system',subtype:'init',session_id:'session-id',tools:[]});
 if(prompt==='hold') {setInterval(()=>{},1000);return;}
 if(prompt==='invalid') {console.log('broken JSON');return;}
 if(prompt==='exit') {process.stderr.write('not signed in');process.exit(1);}
 const schema = args.includes('--json-schema');
 const text = schema ? '{"ok":true}' : prompt;
 if(!schema) for (const part of [text.slice(0, 2), text.slice(2)]) send({type:'stream_event',parent_tool_use_id:null,event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:part}}});
 send({type:'assistant',message:{content:[{type:'text',text}]}});
 send({type:'result',subtype:'success',is_error:prompt==='fail',result:prompt==='fail'?'API Error: overloaded':text,...(schema?{structured_output:{ok:true}}:{}),usage:{input_tokens:4,cache_creation_input_tokens:3,cache_read_input_tokens:3,output_tokens:5,output_tokens_details:{thinking_tokens:1}}});
});
`, { mode: 0o700 });
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const previous = process.env.CLAUDECODE; process.env.CLAUDECODE = '1';
  const server = new LocalServer({ directory }); server.configure({ backend: 'claude', claudeBinary: binary, port });
  await server.start();
  t.after(async () => { await server.stop(); if (previous === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  const post = (body, endpoint = 'chat/completions') => fetch(`http://127.0.0.1:${port}/v1/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const lastArgs = () => JSON.parse(fs.readFileSync(path.join(directory, 'last-args.json'), 'utf8'));
  return { server, post, directory, port, lastArgs };
}
const chat = content => ({ messages: [{ role: 'user', content }] });

test('Claude Code catalog, health and settings persistence', async t => {
  const { server, directory, port } = await setup(t);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).backend, 'claude-code');
  const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
  assert.deepEqual(models.data.map(m => m.id), ['sonnet', 'opus', 'fable', 'haiku']); assert.equal(models.data[0].owned_by, 'claude');
  assert.equal(server.account.type, 'Claude Code');
  await server.stop();
  assert.equal(new LocalServer({ directory }).settings.backend, 'claude');
});
test('Claude Code streams deltas, forwards effort and instructions, and maps usage', async t => {
  const { server, post, lastArgs } = await setup(t);
  const reply = await (await post({ model: 'opus', reasoning_effort: 'high', messages: [{ role: 'system', content: 'Be terse.' }, { role: 'user', content: 'こんにちは' }] })).json();
  assert.equal(reply.choices[0].message.content, 'こんにちは');
  assert.equal(reply.usage.prompt_tokens, 10); assert.equal(reply.usage.total_tokens, 15); assert.equal(reply.usage.prompt_tokens_details.cached_tokens, 3);
  const args = lastArgs(); assert.equal(args[args.indexOf('--effort') + 1], 'high'); assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.match(args[args.indexOf('--system-prompt') + 1], /Be terse\./);
  const stream = await (await post({ ...chat('stream'), stream: true, stream_options: { include_usage: true } })).text();
  assert.match(stream, /"content":"st"/); assert.match(stream, /"content":"ream"/); assert.match(stream, /\[DONE\]/);
  assert.equal((await post({ ...chat('x'), reasoning_effort: 'minimal' })).status, 400);
  const row = server.store.list().find(r => r.model); assert.equal(row.backend, 'claude'); assert.equal(row.threadId, 'session-id'); assert.equal(row.usage.reasoningOutputTokens, 1);
  assert.deepEqual(fs.readdirSync(path.join(server.directory, 'workspace')), []);
});
test('Claude Code structured output and errors', async t => {
  const { post } = await setup(t);
  const request = { input: 'schema', text: { format: { type: 'json_schema', name: 'test', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } };
  const json = await (await post(request, 'responses')).json(); assert.deepEqual(JSON.parse(json.output[0].content[0].text), { ok: true });
  for (const prompt of ['fail', 'invalid', 'exit']) assert.equal((await post(chat(prompt))).status, 502);
  assert.match((await (await post(chat('fail'))).json()).error.message, /overloaded/);
  assert.match((await (await post(chat('exit'))).json()).error.message, /not signed in/);
});
test('Claude Code cancellation and timeout terminate CLI children', async t => {
  const { server, post } = await setup(t);
  const response = post(chat('hold'));
  while (!server.store.list().some(r => r.threadId)) await new Promise(r => setTimeout(r, 10));
  server.cancel(server.store.list().find(r => r.threadId).id);
  assert.equal((await response).status, 499);
  server.settings.timeout = 0.05;
  assert.equal((await post(chat('hold'))).status, 504);
  assert.equal(server.rpc.jobs.size, 0);
});
test('Claude Code start fails clearly when the executable is missing', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-missing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const server = new LocalServer({ directory }); server.configure({ backend: 'claude', claudeBinary: path.join(directory, 'nope'), port: 18999 });
  await assert.rejects(server.start(), /Claude Code: .*ENOENT/);
  assert.equal(server.state, 'error');
});
