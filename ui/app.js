const $ = id => document.getElementById(id);
let snapshot = { state: 'stopped', settings: {}, models: [], diagnostics: [] };
let rows = []; let selectedId = null; let filter = 'all'; let tab = 'messages'; let pending = false; let toastTimer;
const statusNames = { stopped: '停止中', starting: '起動中', running: '稼働中', stopping: '停止中…', error: '接続エラー' };
const rowNames = { running: '生成中', completed: '完了', error: 'エラー', cancelled: '中断', interrupted: '中断' };
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
async function call(method, arg) { try { return await window.api.call(method, arg); } catch (err) { toast(err.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); throw err; } }
function click(id, action) { $(id).addEventListener('click', () => Promise.resolve().then(action).catch(() => {})); }
function preview(row) {
  const body = row.request;
  const user = body?.messages?.findLast(m => m.role === 'user');
  const input = user?.content ?? body?.input;
  return typeof input === 'string' ? input : input ? JSON.stringify(input) : row.error || (row.path === '/v1/models' ? '利用可能なモデルを取得' : row.path === '/health' ? 'サーバーの状態を確認' : 'リクエストを受信しました');
}
function populateSelect(select, models, current, includeDefault) {
  select.replaceChildren();
  if (includeDefault) { const option = el('option', '', 'Codex の既定モデル'); option.value = ''; select.append(option); }
  for (const m of models) { const option = el('option', '', m.displayName || m.model); option.value = m.model; select.append(option); }
  if (current && !models.some(m => m.model === current)) { const option = el('option', '', `${current}（未取得）`); option.value = current; select.append(option); }
  if (current) select.value = current;
}
function renderState() {
  $('statusLabel').textContent = statusNames[snapshot.state];
  $('statusDot').className = `dot ${snapshot.state === 'running' ? 'running' : ''}`;
  $('statusDot').style.background = snapshot.state === 'running' ? '#92d9a6' : snapshot.state === 'error' ? '#e6a38c' : '#78867e';
  $('toggleServer').textContent = snapshot.state === 'running' ? 'サーバーを停止' : 'サーバーを起動';
  $('toggleServer').classList.toggle('stop', snapshot.state === 'running');
  $('toggleServer').disabled = pending || ['starting','stopping'].includes(snapshot.state);
  $('baseURL').textContent = snapshot.baseURL || 'http://127.0.0.1:8787/v1';
  const model = snapshot.models.find(m => m.model === snapshot.settings.model) || snapshot.models.find(m => m.isDefault) || snapshot.models[0];
  $('modelSummary').textContent = snapshot.models.length ? `${model?.displayName || model?.model} · ${snapshot.models.length} models` : '起動時にモデルを取得';
  $('refreshModels').disabled = snapshot.state !== 'running';
  $('accountLabel').textContent = snapshot.account ? `${snapshot.account.type}${snapshot.account.planType ? ' / ' + snapshot.account.planType : ''}` : 'Codex CLI の認証を使用';
  $('serverError').hidden = !snapshot.error;
  $('serverError').textContent = snapshot.error || '';
  $('diagnostics').textContent = snapshot.diagnostics.map(d => `${d.time}\n${d.message}`).join('\n') || '診断ログはまだありません';
}
function renderMetrics() {
  const generated = rows.filter(r => r.method === 'POST' && r.model);
  const completed = generated.filter(r => r.status === 'completed' && r.duration !== undefined);
  $('requestCount').textContent = rows.length;
  $('totalMetric').replaceChildren(document.createTextNode(rows.length), el('small', '', 'requests'));
  $('activeMetric').replaceChildren(document.createTextNode(rows.filter(r => r.status === 'running').length), el('small', '', 'active'));
  $('latencyMetric').replaceChildren(document.createTextNode(completed.length ? (completed.reduce((n, r) => n + r.duration, 0) / completed.length / 1000).toFixed(1) : '—'), el('small', '', 'sec'));
  $('errorMetric').replaceChildren(document.createTextNode(rows.filter(r => ['error','cancelled','interrupted'].includes(r.status)).length), el('small', '', 'errors'));
  const ended = rows.filter(r => r.status !== 'running');
  $('successMetric').textContent = ended.length ? `成功率 ${(ended.filter(r => r.status === 'completed').length / ended.length * 100).toFixed(0)}%` : 'リクエストを待機中';
}
function renderList() {
  const query = $('search').value.toLowerCase();
  const visible = rows.filter(row => (filter === 'all' || (filter === 'error' ? ['error','cancelled','interrupted'].includes(row.status) : row.status === filter)) && `${row.model || ''} ${row.path} ${preview(row)} ${row.text} ${row.error || ''}`.toLowerCase().includes(query));
  const list = $('requestList'); const scrollTop = list.scrollTop;
  list.replaceChildren();
  if (!visible.length) list.append(el('div', 'empty-list', rows.length ? '条件に一致するログがありません。' : 'まだリクエストはありません。\nサーバーを起動して接続してください。'));
  for (const row of visible) {
    const node = el('button', `request-row${row.id === selectedId ? ' selected' : ''}`);
    const top = el('div', 'row-top'); top.append(el('span', 'method', row.method), el('span', 'route', row.path), el('span', 'row-time', new Date(row.time).toLocaleTimeString('ja-JP', { hour12: false })));
    const bottom = el('div', 'row-bottom'); bottom.append(el('span', `badge ${row.status}`, rowNames[row.status] || row.status), el('span', 'row-model', row.model || 'system'));
    if (row.stream) bottom.append(el('span', 'badge', 'SSE'));
    bottom.append(el('span', 'row-duration', row.duration !== undefined ? `${(row.duration / 1000).toFixed(2)} s` : '…'));
    node.append(top, el('div', 'row-prompt', preview(row)), bottom);
    node.onclick = () => { selectedId = row.id; renderList(); renderDetail(); };
    list.append(node);
  }
  list.scrollTop = scrollTop;
  $('visibleCount').textContent = `${visible.length} 件のリクエスト`;
}
function message(role, value, isStreaming = false) {
  const block = el('div', `message-block ${role}`); block.append(el('div', 'message-role', role.toUpperCase()));
  block.append(el('div', `message-text${isStreaming ? ' streaming-cursor' : ''}`, typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
  return block;
}
function renderDetail() {
  const row = rows.find(r => r.id === selectedId);
  if (!row) return;
  const panel = $('detailPanel'); const wasAtBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 50; const oldScroll = panel.scrollTop;
  panel.replaceChildren();
  const head = el('div', 'detail-head'); head.append(el('strong', '', 'リクエスト詳細'), el('span', '', row.id.slice(0, 8)));
  const tabs = el('div', 'detail-tabs');
  for (const [key, label] of [['messages','メッセージ'],['request','Request'],['response','Response'],['events','Codex events']]) {
    const button = el('button', `detail-tab${tab === key ? ' selected' : ''}`, label); button.onclick = () => { tab = key; renderDetail(); }; tabs.append(button);
  }
  const body = el('div', 'detail-body');
  const meta = el('div', 'detail-meta'); meta.append(el('span', '', `HTTP ${row.httpStatus || '…'}`), el('span', '', rowNames[row.status]));
  if (row.usage) meta.append(el('span', '', `${row.usage.totalTokens.toLocaleString()} tokens`));
  body.append(meta);
  if (row.status === 'running') { const cancel = el('button', 'quiet', '生成を中断'); cancel.onclick = () => call('cancel', row.id).catch(() => {}); body.append(cancel); }
  if (row.error) body.append(el('div', 'error-message', row.error));
  if (tab === 'messages') {
    if (row.request?.messages) for (const m of row.request.messages) body.append(message(m.role, m.content));
    else if (row.request?.input) { if (row.request.instructions) body.append(message('system', row.request.instructions)); body.append(message('user', row.request.input)); }
    if (row.text || row.status === 'running') body.append(message('assistant', row.text || '応答を待っています…', row.status === 'running'));
    if (!row.request && row.response) body.append(message('system', row.response));
  } else {
    const data = tab === 'request' ? row.request : tab === 'response' ? row.response || { partial_text: row.text } : { events: row.events, truncated: !!row.eventsTruncated, thread_id: row.threadId };
    const toolbar = el('div', 'json-toolbar'); const copy = el('button', 'quiet', 'JSON をコピー');
    copy.onclick = () => navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => toast('コピーしました')).catch(() => toast('コピーできませんでした'));
    toolbar.append(copy); body.append(toolbar, el('pre', '', JSON.stringify(data, null, 2)));
  }
  panel.append(head, tabs, body); panel.scrollTop = wasAtBottom && row.status === 'running' ? panel.scrollHeight : oldScroll;
}
function render() { renderMetrics(); renderList(); renderDetail(); }
function openPlayground() {
  populateSelect($('testModel'), snapshot.models, snapshot.settings.model || snapshot.models.find(m => m.isDefault)?.model, false);
  $('sendTest').disabled = snapshot.state !== 'running'; $('playgroundDialog').showModal();
}
function effortOptions(current = '') {
  const form = $('settingsForm'); const select = form.elements.effort; const model = snapshot.models.find(m => m.model === form.elements.model.value) || snapshot.models.find(m => m.isDefault) || snapshot.models[0];
  select.replaceChildren(); const option = el('option', '', 'モデルの既定値'); option.value = ''; select.append(option);
  for (const entry of model?.supportedReasoningEfforts || []) { const option = el('option', '', entry.reasoningEffort); option.value = entry.reasoningEffort; select.append(option); }
  if (Array.from(select.options).some(o => o.value === current)) select.value = current;
}
click('toggleServer', async () => {
  pending = true; renderState();
  try { snapshot = await call(snapshot.state === 'running' ? 'stop' : 'start'); } finally { pending = false; renderState(); }
});
click('copyURL', async () => { await navigator.clipboard.writeText(snapshot.baseURL); toast('エンドポイントをコピーしました'); });
click('refreshModels', async () => { await call('models'); toast('モデル一覧を更新しました'); });
click('showRequests', () => { $('search').value = ''; filter = 'all'; document.querySelectorAll('.filter').forEach(b => b.classList.toggle('selected', b.dataset.filter === 'all')); renderList(); });
click('showPlayground', openPlayground); click('emptyPlayground', openPlayground);
click('showSettings', () => {
  const form = $('settingsForm');
  for (const k of ['port','binary','timeout']) form.elements[k].value = snapshot.settings[k];
  populateSelect(form.elements.model, snapshot.models, snapshot.settings.model, true); effortOptions(snapshot.settings.effort);
  const editable = ['stopped','error'].includes(snapshot.state);
  for (const input of form.querySelectorAll('input,select')) input.disabled = !editable;
  $('saveSettings').disabled = !editable; $('settingsDialog').showModal();
});
$('settingsForm').elements.model.addEventListener('change', () => effortOptions());
click('openLogs', () => call('open-logs'));
click('exportLogs', async () => { if (await call('export')) toast('ログをエクスポートしました'); });
click('clearLogs', async () => { await call('clear'); toast('ログをクリアしました'); });
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } }));
$('settingsForm').addEventListener('submit', async event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
  try { snapshot = await call('configure', data); $('settingsDialog').close(); toast('設定を保存しました'); renderState(); } catch {}
});
$('playgroundForm').addEventListener('submit', async event => {
  event.preventDefault(); $('sendTest').disabled = true; $('sendTest').textContent = '生成中…';
  const result = $('testResult'); result.hidden = false; result.classList.remove('error'); result.textContent = 'Codex の応答を待っています…';
  try {
    const messages = []; if ($('testSystem').value) messages.push({ role: 'system', content: $('testSystem').value }); messages.push({ role: 'user', content: $('testPrompt').value });
    const response = await call('test-request', { model: $('testModel').value, messages });
    result.textContent = response.choices[0].message.content;
  } catch (err) { result.classList.add('error'); result.textContent = err.message; }
  finally { $('sendTest').disabled = snapshot.state !== 'running'; $('sendTest').textContent = '▷ リクエストを送信'; }
});
$('search').addEventListener('input', renderList);
document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter; document.querySelectorAll('.filter').forEach(b => b.classList.toggle('selected', b === button)); renderList(); }));
window.api.on('state', state => { snapshot = state; renderState(); });
window.api.on('diagnostic', entry => { snapshot.diagnostics.push(entry); snapshot.diagnostics = snapshot.diagnostics.slice(-80); $('diagnostics').textContent = snapshot.diagnostics.map(d => `${d.time}\n${d.message}`).join('\n'); });
window.api.on('log', row => { const index = rows.findIndex(r => r.id === row.id); if (index < 0) rows.unshift(row); else rows[index] = row; rows = rows.slice(0,300); if (!selectedId) selectedId = row.id; render(); });
window.api.on('reset', () => { rows = []; selectedId = null; render(); $('detailPanel').replaceChildren(el('div', 'empty-detail', 'ログをクリアしました。次のリクエストを待っています。')); });
window.api.call('snapshot').then(data => { snapshot = data; rows = data.logs; renderState(); render(); }).catch(err => toast(err.message));
