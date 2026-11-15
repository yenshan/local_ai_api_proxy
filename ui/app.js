const $ = id => document.getElementById(id);
let snapshot = { state: 'stopped', settings: {}, models: [] };
let rows = []; let clearingLogs = false; let pending = false; let playgroundBusy = false; let toastTimer;
let settingsSignature = '';
let settingsDirty = false; let settingsBusy = false; let settingsTimer; let settingsLocked = false;
const statusNames = { stopped: '停止中', starting: '起動中', running: '稼働中', stopping: '停止中…', error: '接続エラー' };
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
async function call(method, arg) { try { return await window.api.call(method, arg); } catch (err) { toast(err.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); throw err; } }
function click(id, action) { $(id).addEventListener('click', () => Promise.resolve().then(action).catch(() => {})); }
function populateSelect(select, models, current) {
  select.replaceChildren();
  for (const model of models) { const option = el('option', '', model.displayName || model.model); option.value = model.model; select.append(option); }
  if (models.some(model => model.model === current)) select.value = current;
}
function playgroundModels() {
  return $('settingsForm').elements.backend.value === snapshot.settings.backend ? snapshot.models : [];
}
function renderPlayground() {
  const models = playgroundModels();
  const changedBackend = $('settingsForm').elements.backend.value !== snapshot.settings.backend;
  const model = models.find(m => m.isDefault) || models[0];
  const emptyLabel = changedBackend ? '設定を反映中…' : 'サーバー起動後にモデルを取得';
  $('modelSummary').textContent = models.length ? `${model?.displayName || model?.model} · ${models.length} models` : emptyLabel;
  $('refreshModels').disabled = settingsDirty || settingsBusy || changedBackend || snapshot.state !== 'running';
  $('toggleServer').disabled = pending || settingsDirty || settingsBusy || ['starting', 'stopping'].includes(snapshot.state) || (changedBackend && snapshot.state !== 'running');
  const previousModel = $('testModel').value;
  const selectedModel = models.some(m => m.model === previousModel) ? previousModel : model?.model;
  populateSelect($('testModel'), models, selectedModel);
  if (!models.length) { const option = el('option', '', emptyLabel); option.value = ''; $('testModel').append(option); }
  $('testModel').disabled = !models.length;
  renderPlaygroundEffort(previousModel === selectedModel ? $('testEffort').value : '');
  $('sendTest').disabled = playgroundBusy || settingsDirty || settingsBusy || changedBackend || snapshot.state !== 'running' || !models.length;
}
function renderState() {
  $('statusLabel').textContent = statusNames[snapshot.state];
  $('statusDot').className = `dot ${snapshot.state === 'running' ? 'running' : ''}`;
  $('statusDot').style.background = snapshot.state === 'running' ? '#23845c' : snapshot.state === 'error' ? '#bd5437' : '#84948b';
  $('toggleServer').textContent = snapshot.state === 'running' ? 'サーバーを停止' : 'サーバーを起動';
  $('toggleServer').classList.toggle('stop', snapshot.state === 'running');
  $('toggleServer').disabled = pending || ['starting','stopping'].includes(snapshot.state);
  $('baseURL').textContent = snapshot.baseURL || 'http://127.0.0.1:8787/v1';
  renderSettings();
  renderPlayground();
  $('serverError').hidden = !snapshot.error;
  $('serverError').textContent = snapshot.error || '';
}
function antigravityEffortVariants() {
  if (snapshot.settings.backend !== 'antigravity') return [];
  const selected = $('testModel').value.match(/^(.*)-(minimal|low|medium|high|xhigh|max)$/);
  if (!selected) return [];
  return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].flatMap(effort => {
    const model = playgroundModels().find(m => m.model === `${selected[1]}-${effort}`);
    return model ? [{ effort, model: model.model }] : [];
  });
}
function renderPlaygroundEffort(current = '') {
  const select = $('testEffort');
  const variants = antigravityEffortVariants();
  select.replaceChildren();
  if (variants.length) {
    for (const variant of variants) { const option = el('option', '', variant.effort); option.value = variant.effort; select.append(option); }
    select.value = variants.find(v => v.model === $('testModel').value).effort;
    select.disabled = variants.length < 2;
    return;
  }
  const option = el('option', '', 'モデルの既定値'); option.value = ''; select.append(option);
  const model = playgroundModels().find(m => m.model === $('testModel').value);
  const efforts = snapshot.settings.backend === 'antigravity' ? [] : model?.supportedReasoningEfforts || [];
  for (const entry of efforts) { const option = el('option', '', entry.reasoningEffort); option.value = entry.reasoningEffort; select.append(option); }
  if (Array.from(select.options).some(option => option.value === current)) select.value = current;
  select.disabled = !efforts.length;
}
$('testModel').addEventListener('change', () => renderPlaygroundEffort());
$('testEffort').addEventListener('change', () => {
  const variant = antigravityEffortVariants().find(v => v.effort === $('testEffort').value);
  if (variant) { $('testModel').value = variant.model; renderPlaygroundEffort(); }
});
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
const logDateFormat = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function render() {
  const activeLogs = rows.some(row => row.status === 'running');
  $('clearLogs').disabled = clearingLogs || activeLogs || !rows.length;
  $('clearLogs').title = activeLogs ? '通信の完了後にクリアできます' : '保存済みの通信ログをすべてクリア';
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
    const date = new Date(row.time);
    if (Number.isFinite(date.getTime())) {
      const time = el('time', 'communication-time', logDateFormat.format(date));
      time.dateTime = date.toISOString(); node.append(time);
    }
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
click('clearLogs', async () => {
  if ($('clearLogs').disabled) return;
  clearingLogs = true; render();
  try { await call('clear'); toast('通信ログをクリアしました'); }
  finally { clearingLogs = false; render(); }
});
click('copyURL', async () => { await navigator.clipboard.writeText(snapshot.baseURL); toast('エンドポイントをコピーしました'); });
click('refreshModels', async () => { await call('models'); toast('モデル一覧を更新しました'); });
function renderSettings() {
  const form = $('settingsForm');
  const locked = !['stopped', 'error'].includes(snapshot.state);
  if (locked) {
    clearTimeout(settingsTimer); settingsDirty = false; settingsSignature = '';
    settingsStatus('設定変更はサーバー停止後に行えます。');
  } else if (settingsLocked) settingsStatus('変更は自動で反映されます。');
  settingsLocked = locked;
  const settingsKey = JSON.stringify(snapshot.settings);
  if (!settingsDirty && settingsKey !== settingsSignature) {
    for (const key of ['port', 'binary', 'antigravityBinary', 'backend', 'timeout']) form.elements[key].value = snapshot.settings[key] ?? '';
  }
  settingsSignature = settingsKey;
  const editable = !settingsBusy && !locked;
  for (const input of form.querySelectorAll('input,select')) input.disabled = !editable;
  backendFields();
}
function backendFields() {
  const form = $('settingsForm'); const agy = form.elements.backend.value === 'antigravity';
  $('codexBinaryField').hidden = agy; $('antigravityBinaryField').hidden = !agy;
}
function settingsStatus(message, error = false) {
  $('settingsStatus').textContent = message;
  $('settingsStatus').classList.toggle('settings-status-error', error);
}
async function applyFormSettings() {
  clearTimeout(settingsTimer);
  if (settingsBusy || !settingsDirty || !['stopped', 'error'].includes(snapshot.state)) return;
  const form = $('settingsForm');
  if (!form.checkValidity()) { settingsStatus('有効な設定値を入力してください。', true); return; }
  const data = Object.fromEntries(new FormData(form));
  const focused = form.contains(document.activeElement) ? document.activeElement : null;
  const selection = focused?.type === 'text' ? [focused.selectionStart, focused.selectionEnd] : null;
  settingsBusy = true; settingsStatus('設定を反映中…'); renderState();
  try {
    snapshot = await window.api.call('configure', data);
    settingsDirty = false;
    settingsStatus('変更を反映しました。');
  } catch (err) {
    settingsDirty = !Object.entries(data).every(([key, value]) => String(snapshot.settings[key]) === value);
    settingsStatus(err.message.replace(/^Error invoking remote method '[^']+': Error: /, ''), true);
  } finally {
    settingsBusy = false;
    if (!settingsDirty) settingsSignature = '';
    renderState();
    if (focused && !focused.disabled && document.activeElement === document.body) {
      focused.focus(); if (selection) focused.setSelectionRange(...selection);
    }
  }
}
function settingsChanged(event, immediate) {
  if (settingsBusy || !['stopped', 'error'].includes(snapshot.state) || event.target.disabled) return;
  settingsDirty = true;
  clearTimeout(settingsTimer);
  backendFields();
  if (event.target.name === 'backend') { $('testModel').replaceChildren(); $('testEffort').value = ''; $('testResult').hidden = true; }
  settingsStatus('設定を反映中…'); renderPlayground();
  if (immediate) applyFormSettings();
  else settingsTimer = setTimeout(applyFormSettings, 400);
}
$('settingsForm').addEventListener('input', event => { if (event.target.tagName === 'INPUT') settingsChanged(event, false); });
$('settingsForm').addEventListener('change', event => settingsChanged(event, true));
$('settingsForm').addEventListener('submit', event => { event.preventDefault(); applyFormSettings(); });
$('playgroundForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (playgroundBusy || settingsDirty || settingsBusy || snapshot.state !== 'running' || !playgroundModels().some(model => model.model === $('testModel').value)) return;
  playgroundBusy = true; $('sendTest').disabled = true; $('sendTest').textContent = '生成中…';
  const result = $('testResult'); result.hidden = false; result.classList.remove('error'); result.textContent = 'AI の応答を待っています…';
  try {
    const messages = [{ role: 'user', content: $('testPrompt').value }];
    const effort = $('testEffort').value;
    const response = await call('test-request', { model: $('testModel').value, messages,
      ...(effort && snapshot.settings.backend !== 'antigravity' ? { reasoning_effort: effort } : {}) });
    result.textContent = response.choices[0].message.content;
  } catch (err) { result.classList.add('error'); result.textContent = err.message; }
  finally { playgroundBusy = false; renderState(); $('sendTest').textContent = '▷ リクエストを送信'; }
});
window.api.on('state', state => { snapshot = state; renderState(); });
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
