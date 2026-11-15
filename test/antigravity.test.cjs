const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { LocalServer } = require('../src/server.cjs');
const { AntigravityBackend, parseModels } = require('../src/antigravity.cjs');

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-test-'));
  const binary = path.join(directory, 'agy');
  fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if(args[0] === 'models') { console.log('gemini-test\\tGemini Test\\nclaude-test\\tClaude Test'); process.exit(); }
const agent = fs.readFileSync('.agents/agents/local-api-text.md', 'utf8');
if (!agent.includes('tools: [finish]') || !agent.includes('Only generate a reply')) process.exit(3);
let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d=>input+=d);
process.stdin.on('end', ()=> {
 const prompt=JSON.parse(input).message.content;
 const send = e => console.log(JSON.stringify(e));
 send({event:'init', conversation_id:'test-id', init:{agent:'local-api-text',tools:['finish']}});
 if(prompt==='hold') {setInterval(()=>{},1000);return;}
 if(prompt==='invalid') {console.log('broken JSON');return;}
 if(prompt==='exit') {process.stderr.write('backend unavailable');process.exit(1);}
 const schema = args.includes('--json-schema');
 const text = schema ? '{"ok":true}' : prompt;
 if(!schema) send({event:'step_update',step_update:{step_type:'agent_response',text_delta:text}});
 send({event:'result',result:{status:prompt==='fail'?'ERROR':'SUCCESS',error:'upstream failure',response:text,...(schema?{structured_output:{ok:true}}:{}),usage:{input_tokens:10,output_tokens:5,total_tokens:15,cache_read_tokens:2,thinking_tokens:1}}});
});
`, { mode: 0o700 });
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p=s.address().port; s.close(()=>resolve(p)); }); });
  const server = new LocalServer({directory}); server.configure({backend:'antigravity',antigravityBinary:binary,port});
  await server.start();
  t.after(async()=> {await server.stop();fs.rmSync(directory,{recursive:true,force:true});});
  const post = (body, endpoint='chat/completions') => fetch(`http://127.0.0.1:${port}/v1/${endpoint}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {server,post,directory,port};
}
const chat = content => ({messages:[{role:'user',content}]});

test('Antigravity catalog, HTTP health, backend selection persistence and switch isolation', async t=> {
 const {server,directory,port}=await setup(t);
 assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).backend,'antigravity');
 const models=await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
 assert.deepEqual(models.data.map(m=>m.id),['gemini-test','claude-test']);assert.equal(models.data[0].owned_by,'antigravity');
 assert.throws(()=>server.configure({backend:'codex'}),/停止/);
 await server.stop();server.configure({model:'gemini-test'});
 assert.equal(new LocalServer({directory}).settings.backend,'antigravity');
 server.configure({backend:'codex'});assert.equal(server.settings.model,'');assert.deepEqual(server.models,[]);
 assert.throws(()=>server.configure({backend:'unknown'}),/Invalid backend/);
 assert.throws(()=>parseModels('Fetching models...'),/モデル一覧/);
});
test('Antigravity uses separate CLI processes, maps usage and streams without duplicated final text', async t=> {
 const {server,post}=await setup(t);
 const [a,b]=await Promise.all([post(chat('こんにちは')).then(r=>r.json()),post(chat('second')).then(r=>r.json())]);
 assert.equal(a.choices[0].message.content,'こんにちは');assert.equal(b.choices[0].message.content,'second');assert.equal(a.usage.total_tokens,15);
 const stream=await(await post({...chat('stream'),stream:true,stream_options:{include_usage:true}})).text();
 assert.equal((stream.match(/"content":"stream"/g)||[]).length,1);assert.match(stream,/\[DONE\]/);
 const row=server.store.list().find(r=>r.model);assert.equal(row.backend,'antigravity');assert.equal(row.usage.reasoningOutputTokens,1);
 assert.deepEqual(fs.readdirSync(path.join(server.directory,'workspace')),[]);
});
test('Antigravity structured Responses and SSE, explicit upstream and validation errors',async t=> {
 const {post}=await setup(t);
 const request={input:'schema',text:{format:{type:'json_schema',name:'test',schema:{type:'object',properties:{ok:{type:'boolean'}}}}}};
 const json=await(await post(request,'responses')).json();assert.deepEqual(JSON.parse(json.output[0].content[0].text),{ok:true});
 const stream=await(await post({...request,stream:true},'responses')).text();assert.match(stream,/event: response.completed/);assert.match(stream,/response.output_text.delta/);
 for(const prompt of ['fail','invalid','exit']) assert.equal((await post(chat(prompt))).status,502);
 const failed=await(await post({input:'fail',stream:true},'responses')).text();
 assert.match(failed,/event: response.failed/);
 assert.equal((await post({...chat('test'),reasoning_effort:'high'})).status,400);
});
test('Antigravity cancellation and timeout settle requests and terminate CLI children',async t=> {
 const {server,post}=await setup(t);
 const response=post(chat('hold'));
 while(!server.store.list().some(r=>r.threadId)) await new Promise(r=>setTimeout(r,10));
 server.cancel(server.store.list().find(r=>r.threadId).id);
 assert.equal((await response).status,499);
 server.settings.timeout=0.05;
 assert.equal((await post(chat('hold'))).status,504);
 assert.equal(server.rpc.jobs.size,0);
});
