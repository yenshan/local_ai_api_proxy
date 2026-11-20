const $ = id => document.getElementById(id);
let snapshot = { state: 'stopped', settings: {}, models: [] };
let rows = []; let clearingLogs = false; let exportingLogs = false; let pending = false; let playgroundBusy = false; let toastTimer;
let settingsSignature = '';
let settingsDirty = false; let settingsBusy = false; let settingsTimer; let settingsLocked = false;
const statusNames = { stopped: 'Stopped', starting: 'Starting…', running: 'Running', stopping: 'Stopping…', error: 'Connection Error' };
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
  const emptyLabel = changedBackend ? 'Applying settings…' : 'Start the server to load models';
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
  $('toggleServer').textContent = snapshot.state === 'running' ? 'Stop Server' : 'Start Server';
  $('toggleServer').classList.toggle('stop', snapshot.state === 'running');
  $('toggleServer').disabled = pending || ['starting','stopping'].includes(snapshot.state);
  $('baseURL').textContent = snapshot.baseURL || 'http://127.0.0.1:8787/v1';
  renderSettings();
  renderPlayground();
  $('serverError').hidden = !snapshot.error;
  $('serverError').textContent = snapshot.error || '';
}
function renderPlaygroundEffort(current = '') {
  const select = $('testEffort');
  select.replaceChildren();
  const option = el('option', '', 'Model default'); option.value = ''; select.append(option);
  const model = playgroundModels().find(m => m.model === $('testModel').value);
  const efforts = model?.supportedReasoningEfforts || [];
  for (const entry of efforts) { const option = el('option', '', entry.reasoningEffort); option.value = entry.reasoningEffort; select.append(option); }
  if (Array.from(select.options).some(option => option.value === current)) select.value = current;
  select.disabled = !efforts.length;
}
$('testModel').addEventListener('change', () => renderPlaygroundEffort());
function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
  return '';
}
function message(role, value, isStreaming = false) {
  const safeRole = ['system', 'developer', 'user', 'assistant', 'error'].includes(role) ? role : 'user';
  const labels = { system: 'System', developer: 'Developer', user: 'Request', assistant: 'Response', error: 'Error' };
  const block = el('div', `message-block ${safeRole}`);
  block.append(el('div', 'message-role', labels[safeRole]));
  block.append(el('div', `message-text${isStreaming ? ' streaming-cursor' : ''}`, contentText(value)));
  return block;
}
const communicationNodes = new Map();
function formatLogDate(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function render() {
  const activeLogs = rows.some(row => row.status === 'running');
  $('clearLogs').disabled = clearingLogs || exportingLogs || activeLogs || !rows.length;
  $('clearLogs').title = activeLogs ? 'Wait for all requests to finish before clearing logs' : 'Clear all saved logs';
  const panel = $('communicationLog');
  const atBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 50;
  const oldScroll = panel.scrollTop;
  const communications = rows.filter(row => row.method === 'POST' && /^\/v1\/(chat\/completions|responses)(?:\?|$)/.test(row.path) && row.request).slice().reverse();
  $('exportLogs').disabled = exportingLogs || clearingLogs || !communications.length;
  const ids = new Set(communications.map(row => row.id));
  for (const [id, node] of communicationNodes) if (!ids.has(id)) { node.remove(); communicationNodes.delete(id); }
  panel.querySelector('.empty-log')?.remove();
  if (!communications.length) panel.append(el('div', 'empty-log', 'Waiting for requests…'));
  for (const row of communications) {
    let node = communicationNodes.get(row.id);
    if (!node) { node = el('article', 'communication'); communicationNodes.set(row.id, node); panel.append(node); }
    if (node.logRow === row) continue;
    node.logRow = row;
    node.replaceChildren();
    const date = new Date(row.time);
    if (Number.isFinite(date.getTime())) {
      const time = el('time', 'communication-time', formatLogDate(date));
      time.dateTime = date.toISOString(); node.append(time);
    }
    if (row.request.instructions) node.append(message('system', row.request.instructions));
    const messages = Array.isArray(row.request.messages) ? row.request.messages : (Array.isArray(row.request.input) ? row.request.input : [{ role: 'user', content: row.request.input }]);
    for (const entry of messages) if (entry && contentText(entry.content)) node.append(message(entry.role, entry.content));
    if (row.text || row.status === 'running') node.append(message('assistant', row.text || 'Waiting for a response…', row.status === 'running'));
    if (row.error) node.append(message('error', row.error));
  }
  panel.scrollTop = atBottom ? panel.scrollHeight : oldScroll;
}
click('toggleServer', async () => {
  pending = true; renderState();
  try { snapshot = await call(snapshot.state === 'running' ? 'stop' : 'start'); } finally { pending = false; renderState(); }
});
click('exportLogs', async () => {
  if ($('exportLogs').disabled) return;
  exportingLogs = true; render();
  try { if (await call('export')) toast('Traffic log saved as JSON.'); }
  finally { exportingLogs = false; render(); }
});
click('clearLogs', async () => {
  if ($('clearLogs').disabled) return;
  clearingLogs = true; render();
  try { await call('clear'); toast('Traffic log cleared.'); }
  finally { clearingLogs = false; render(); }
});
click('copyURL', async () => { await navigator.clipboard.writeText(snapshot.baseURL); toast('Endpoint URL copied.'); });
click('refreshModels', async () => { await call('models'); toast('Model list refreshed.'); });
function renderSettings() {
  const form = $('settingsForm');
  const locked = !['stopped', 'error'].includes(snapshot.state);
  if (locked) {
    clearTimeout(settingsTimer); settingsDirty = false; settingsSignature = '';
    settingsStatus('Stop the server to change settings.');
  } else if (settingsLocked) settingsStatus('Changes are saved automatically.');
  settingsLocked = locked;
  const settingsKey = JSON.stringify(snapshot.settings);
  if (!settingsDirty && settingsKey !== settingsSignature) {
    for (const key of ['port', 'binary', 'antigravityBinary', 'claudeBinary', 'backend', 'timeout']) form.elements[key].value = snapshot.settings[key] ?? '';
  }
  settingsSignature = settingsKey;
  const editable = !settingsBusy && !locked;
  for (const input of form.querySelectorAll('input,select')) input.disabled = !editable;
  backendFields();
}
function backendFields() {
  const backend = $('settingsForm').elements.backend.value;
  $('codexBinaryField').hidden = backend !== 'codex'; $('antigravityBinaryField').hidden = backend !== 'antigravity'; $('claudeBinaryField').hidden = backend !== 'claude';
}
function settingsStatus(message, error = false) {
  $('settingsStatus').textContent = message;
  $('settingsStatus').classList.toggle('settings-status-error', error);
}
async function applyFormSettings() {
  clearTimeout(settingsTimer);
  if (settingsBusy || !settingsDirty || !['stopped', 'error'].includes(snapshot.state)) return;
  const form = $('settingsForm');
  if (!form.checkValidity()) { settingsStatus('Enter valid settings.', true); return; }
  const data = Object.fromEntries(new FormData(form));
  const focused = form.contains(document.activeElement) ? document.activeElement : null;
  const selection = focused?.type === 'text' ? [focused.selectionStart, focused.selectionEnd] : null;
  settingsBusy = true; settingsStatus('Applying settings…'); renderState();
  try {
    snapshot = await window.api.call('configure', data);
    settingsDirty = false;
    settingsStatus('Changes applied.');
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
  settingsStatus('Applying settings…'); renderPlayground();
  if (immediate) applyFormSettings();
  else settingsTimer = setTimeout(applyFormSettings, 400);
}
$('settingsForm').addEventListener('input', event => { if (event.target.tagName === 'INPUT') settingsChanged(event, false); });
$('settingsForm').addEventListener('change', event => settingsChanged(event, true));
$('settingsForm').addEventListener('submit', event => { event.preventDefault(); applyFormSettings(); });
$('playgroundForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (playgroundBusy || settingsDirty || settingsBusy || snapshot.state !== 'running' || !playgroundModels().some(model => model.model === $('testModel').value)) return;
  playgroundBusy = true; $('sendTest').disabled = true; $('sendTest').textContent = 'Generating…';
  const result = $('testResult'); result.hidden = false; result.classList.remove('error'); result.textContent = 'Waiting for a response…';
  try {
    const messages = [{ role: 'user', content: $('testPrompt').value }];
    const effort = $('testEffort').value;
    const response = await call('test-request', { model: $('testModel').value, messages,
      ...(effort ? { reasoning_effort: effort } : {}) });
    result.textContent = response.choices[0].message.content;
  } catch (err) { result.classList.add('error'); result.textContent = err.message; }
  finally { playgroundBusy = false; renderState(); $('sendTest').textContent = '▷ Send Request'; }
});
window.api.on('state', state => { snapshot = state; renderState(); });
window.api.on('log', row => { const index = rows.findIndex(r => r.id === row.id); if (index < 0) rows.unshift(row); else rows[index] = row; rows = rows.slice(0,300); render(); });
window.api.on('reset', () => { rows = []; render(); });
window.api.call('snapshot').then(data => { snapshot = data; rows = data.logs; renderState(); render(); }).catch(err => toast(err.message));

const toggleSidebar = $('toggleSidebar');
let sidebarCollapsed = false;
try { sidebarCollapsed = localStorage.getItem('sidebarCollapsed') === 'true'; } catch {}
function renderSidebar() {
  document.documentElement.classList.toggle('sidebar-collapsed', sidebarCollapsed);
  toggleSidebar.setAttribute('aria-expanded', String(!sidebarCollapsed));
  const label = sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
  toggleSidebar.setAttribute('aria-label', label); toggleSidebar.title = label;
  $('sidebarToggleIcon').textContent = sidebarCollapsed ? '›' : '‹';
}
toggleSidebar.addEventListener('click', () => {
  sidebarCollapsed = !sidebarCollapsed;
  renderSidebar();
  try { localStorage.setItem('sidebarCollapsed', String(sidebarCollapsed)); } catch {}
});
renderSidebar();
