const $ = id => document.getElementById(id);
let snapshot = { state: 'stopped', settings: {}, models: [], diagnostics: [] };
let rows = []; let pending = false; let playgroundBusy = false; let toastTimer;
let settingsSignature = '';
const statusNames = { stopped: '停止中', starting: '起動中', running: '稼働中', stopping: '停止中…', error: '接続エラー' };
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
async function call(method, arg) { try { return await window.api.call(method, arg); } catch (err) { toast(err.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); throw err; } }
function click(id, action) { $(id).addEventListener('click', () => Promise.resolve().then(action).catch(() => {})); }
function populateSelect(select, models, current, includeDefault) {
  select.replaceChildren();
  if (includeDefault) { const option = el('option', '', 'バックエンドの既定モデル'); option.value = ''; select.append(option); }
  for (const m of models) { const option = el('option', '', m.displayName || m.model); option.value = m.model; select.append(option); }
  if (current && !models.some(m => m.model === current)) { const option = el('option', '', `${current}（未取得）`); option.value = current; select.append(option); }
  if (current) select.value = current;
}
function renderState() {
  $('statusLabel').textContent = statusNames[snapshot.state];
  $('statusDot').className = `dot ${snapshot.state === 'running' ? 'running' : ''}`;
  $('statusDot').style.background = snapshot.state === 'running' ? '#23845c' : snapshot.state === 'error' ? '#bd5437' : '#84948b';
  $('toggleServer').textContent = snapshot.state === 'running' ? 'サーバーを停止' : 'サーバーを起動';
  $('toggleServer').classList.toggle('stop', snapshot.state === 'running');
  $('toggleServer').disabled = pending || ['starting','stopping'].includes(snapshot.state);
  $('baseURL').textContent = snapshot.baseURL || 'http://127.0.0.1:8787/v1';
  const model = snapshot.models.find(m => m.isDefault) || snapshot.models[0];
  $('modelSummary').textContent = snapshot.models.length ? `${model?.displayName || model?.model} · ${snapshot.models.length} models` : '起動時にモデルを取得';
  $('refreshModels').disabled = snapshot.state !== 'running';
  const selectedModel = snapshot.models.some(m => m.model === $('testModel').value) ? $('testModel').value : model?.model;
  populateSelect($('testModel'), snapshot.models, selectedModel, false);
  $('sendTest').disabled = playgroundBusy || snapshot.state !== 'running' || !snapshot.models.length;
  const antigravity = snapshot.settings.backend === 'antigravity';
  $('backendTitle').textContent = `LOCAL DEVELOPMENT / ${antigravity ? 'ANTIGRAVITY' : 'CODEX'}`;
  $('serverError').hidden = !snapshot.error;
  $('serverError').textContent = snapshot.error || '';
  renderSettings();
  $('diagnostics').textContent = snapshot.diagnostics.map(d => `${d.time}\n${d.message}`).join('\n') || '診断ログはまだありません';
}
function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
  return '';
}
function message(role, value, isStreaming = false) {
  const safeRole = ['system', 'developer', 'user', 'assistant', 'error'].includes(role) ? role : 'user';
  const labels = { system: '指示', developer: '指示', user: '送信', assistant: '応答', error: 'エラー' };
  const block = el('div', `message-block ${safeRole}`);
  block.append(el('div', 'message-role', labels[safeRole]));
  block.append(el('div', `message-text${isStreaming ? ' streaming-cursor' : ''}`, contentText(value)));
  return block;
}
const communicationNodes = new Map();
function render() {
  const panel = $('communicationLog');
  const atBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 50;
  const oldScroll = panel.scrollTop;
  const communications = rows.filter(row => row.method === 'POST' && /^\/v1\/(chat\/completions|responses)(?:\?|$)/.test(row.path) && row.request).slice().reverse();
  const ids = new Set(communications.map(row => row.id));
  for (const [id, node] of communicationNodes) if (!ids.has(id)) { node.remove(); communicationNodes.delete(id); }
  panel.querySelector('.empty-log')?.remove();
  if (!communications.length) panel.append(el('div', 'empty-log', '通信を待っています…'));
  for (const row of communications) {
    let node = communicationNodes.get(row.id);
    if (!node) { node = el('article', 'communication'); communicationNodes.set(row.id, node); panel.append(node); }
    if (node.logRow === row) continue;
    node.logRow = row;
    node.replaceChildren();
    if (row.request.instructions) node.append(message('system', row.request.instructions));
    const messages = Array.isArray(row.request.messages) ? row.request.messages : (Array.isArray(row.request.input) ? row.request.input : [{ role: 'user', content: row.request.input }]);
    for (const entry of messages) if (entry && contentText(entry.content)) node.append(message(entry.role, entry.content));
    if (row.text || row.status === 'running') node.append(message('assistant', row.text || '応答を待っています…', row.status === 'running'));
    if (row.error) node.append(message('error', row.error));
  }
  panel.scrollTop = atBottom ? panel.scrollHeight : oldScroll;
}
click('toggleServer', async () => {
  pending = true; renderState();
  try { snapshot = await call(snapshot.state === 'running' ? 'stop' : 'start'); } finally { pending = false; renderState(); }
});
click('copyURL', async () => { await navigator.clipboard.writeText(snapshot.baseURL); toast('エンドポイントをコピーしました'); });
click('refreshModels', async () => { await call('models'); toast('モデル一覧を更新しました'); });
function renderSettings() {
  const form = $('settingsForm');
  const settingsKey = JSON.stringify(snapshot.settings);
  if (settingsKey !== settingsSignature) {
    for (const key of ['port', 'binary', 'antigravityBinary', 'backend', 'timeout']) form.elements[key].value = snapshot.settings[key] ?? '';
  }
  settingsSignature = settingsKey;
  const editable = ['stopped', 'error'].includes(snapshot.state);
  for (const input of form.querySelectorAll('input,select')) input.disabled = !editable;
  $('saveSettings').disabled = !editable;
  backendFields();
}
function backendFields() {
  const form = $('settingsForm'); const agy = form.elements.backend.value === 'antigravity';
  $('codexBinaryField').hidden = agy; $('antigravityBinaryField').hidden = !agy;
}
$('settingsForm').elements.backend.addEventListener('change', backendFields);
$('settingsForm').addEventListener('submit', async event => {
  event.preventDefault(); if (!['stopped', 'error'].includes(snapshot.state)) return; const data = Object.fromEntries(new FormData(event.target));
  try { snapshot = await call('configure', data); toast('設定を保存しました'); renderState(); } catch {}
});
$('playgroundForm').addEventListener('submit', async event => {
  event.preventDefault(); if (playgroundBusy) return; playgroundBusy = true; $('sendTest').disabled = true; $('sendTest').textContent = '生成中…';
  const result = $('testResult'); result.hidden = false; result.classList.remove('error'); result.textContent = 'AI の応答を待っています…';
  try {
    const messages = []; if ($('testSystem').value) messages.push({ role: 'system', content: $('testSystem').value }); messages.push({ role: 'user', content: $('testPrompt').value });
    const response = await call('test-request', { model: $('testModel').value, messages });
    result.textContent = response.choices[0].message.content;
  } catch (err) { result.classList.add('error'); result.textContent = err.message; }
  finally { playgroundBusy = false; renderState(); $('sendTest').textContent = '▷ リクエストを送信'; }
});
window.api.on('state', state => { snapshot = state; renderState(); });
window.api.on('diagnostic', entry => { snapshot.diagnostics.push(entry); snapshot.diagnostics = snapshot.diagnostics.slice(-80); $('diagnostics').textContent = snapshot.diagnostics.map(d => `${d.time}\n${d.message}`).join('\n'); });
window.api.on('log', row => { const index = rows.findIndex(r => r.id === row.id); if (index < 0) rows.unshift(row); else rows[index] = row; rows = rows.slice(0,300); render(); });
window.api.on('reset', () => { rows = []; render(); });
window.api.call('snapshot').then(data => { snapshot = data; rows = data.logs; renderState(); render(); }).catch(err => toast(err.message));

const sidebarResizer = $('sidebarResizer');
const SIDEBAR_DEFAULT = 320;
const SIDEBAR_MIN = 240;
let preferredSidebarWidth = SIDEBAR_DEFAULT;
let sidebarDrag = null;
try {
  const savedWidth = Number(localStorage.getItem('sidebarWidth'));
  if (Number.isFinite(savedWidth) && savedWidth >= SIDEBAR_MIN && savedWidth <= 520) preferredSidebarWidth = savedWidth;
} catch {}
function applySidebarWidth(width) {
  const maximum = Math.max(SIDEBAR_MIN, Math.min(520, window.innerWidth - 680));
  const actual = Math.round(Math.max(SIDEBAR_MIN, Math.min(maximum, width)));
  document.documentElement.style.setProperty('--sidebar-width', `${actual}px`);
  sidebarResizer.setAttribute('aria-valuemax', maximum);
  sidebarResizer.setAttribute('aria-valuenow', actual);
  return actual;
}
function saveSidebarWidth(width) {
  preferredSidebarWidth = width;
  try { localStorage.setItem('sidebarWidth', String(width)); } catch {}
}
sidebarResizer.addEventListener('pointerdown', event => {
  if (event.button !== 0 || sidebarDrag) return;
  event.preventDefault();
  sidebarDrag = { pointerId: event.pointerId, x: event.clientX, width: $('sidebar').getBoundingClientRect().width };
  sidebarResizer.setPointerCapture(event.pointerId);
  sidebarResizer.focus();
  document.body.classList.add('resizing-sidebar');
});
sidebarResizer.addEventListener('pointermove', event => {
  if (sidebarDrag?.pointerId !== event.pointerId) return;
  applySidebarWidth(sidebarDrag.width + event.clientX - sidebarDrag.x);
});
function finishSidebarResize(event) {
  if (sidebarDrag?.pointerId !== event.pointerId) return;
  sidebarDrag = null;
  document.body.classList.remove('resizing-sidebar');
  if (sidebarResizer.hasPointerCapture(event.pointerId)) sidebarResizer.releasePointerCapture(event.pointerId);
  saveSidebarWidth(Number(sidebarResizer.getAttribute('aria-valuenow')));
}
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) sidebarResizer.addEventListener(name, finishSidebarResize);
sidebarResizer.addEventListener('keydown', event => {
  const current = Number(sidebarResizer.getAttribute('aria-valuenow'));
  const step = event.shiftKey ? 40 : 10;
  const widths = { ArrowLeft: current - step, ArrowRight: current + step, Home: SIDEBAR_MIN, End: Number(sidebarResizer.getAttribute('aria-valuemax')) };
  if (!(event.key in widths)) return;
  event.preventDefault(); saveSidebarWidth(applySidebarWidth(widths[event.key]));
});
sidebarResizer.addEventListener('dblclick', () => saveSidebarWidth(applySidebarWidth(SIDEBAR_DEFAULT)));
window.addEventListener('resize', () => applySidebarWidth(preferredSidebarWidth));
applySidebarWidth(preferredSidebarWidth);
