const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { LocalServer } = require('./server.cjs');
const { exportCommunicationLogs } = require('./export.cjs');
app.commandLine.appendSwitch('lang', 'en-US');
// This settings/log UI needs no GPU acceleration. Avoid Linux VA-API driver
// initialization failures by using software rendering before Electron is ready.
if (process.platform === 'linux') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-accelerated-video-decode');
  app.commandLine.appendSwitch('disable-accelerated-video-encode');
}
// Keep the existing settings, logs and Chromium preferences after renaming.
const legacyUserData = path.join(app.getPath('appData'), app.isPackaged ? 'Codex Local API' : 'codex-local-api');
fs.mkdirSync(legacyUserData, { recursive: true });
app.setPath('userData', legacyUserData);
app.setPath('sessionData', legacyUserData);
let window; let server; let exiting = false;
if (process.argv.includes('--smoke')) {
  process.env.CODEX_LOCAL_SMOKE = '1';
  const smokeRoot = app.isPackaged ? path.join(app.getPath('temp'), 'local-ai-api-proxy-smoke') : path.join(__dirname, '..', '.local-data');
  process.env.CODEX_LOCAL_DATA ||= path.join(smokeRoot, 'gui-smoke');
  process.env.CODEX_LOCAL_SCREENSHOT ||= path.join(smokeRoot, 'gui-smoke.png');
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
app.whenReady().then(async () => {
  server = new LocalServer({ directory: process.env.CODEX_LOCAL_DATA || app.getPath('userData') });
  const broadcast = (channel, payload) => { if (window && !window.isDestroyed()) window.webContents.send(channel, payload); };
  server.on('state', state => broadcast('state', state));
  // Coalesce log updates so token streaming does not flood the renderer.
  const dirty = new Map(); server.on('log', row => dirty.set(row.id, row));
  const flush = setInterval(() => { for (const row of dirty.values()) broadcast('log', row); dirty.clear(); }, 100);
  app.on('will-quit', () => clearInterval(flush));
  server.on('reset', () => { dirty.clear(); broadcast('reset'); });
  server.on('diagnostic', entry => broadcast('diagnostic', entry));
  ipcMain.handle('snapshot', () => ({ ...server.snapshot(), logs: server.store.list() }));
  ipcMain.handle('start', () => server.start());
  ipcMain.handle('stop', () => server.stop());
  ipcMain.handle('configure', (_, settings) => server.applySettings(settings));
  ipcMain.handle('models', () => server.refreshModels());
  ipcMain.handle('cancel', (_, id) => server.cancel(id));
  ipcMain.handle('clear', () => server.store.clear());
  ipcMain.handle('open-logs', () => shell.openPath(server.store.directory));
  ipcMain.handle('export', () => exportCommunicationLogs({ parent: window, dialog, rows: server.store.list() }));
  ipcMain.handle('test-request', async (_, body) => {
    if (server.state !== 'running') throw new Error('Start the server first.');
    const response = await fetch(`http://127.0.0.1:${server.settings.port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout((server.settings.timeout + 35) * 1000) });
    const json = await response.json(); if (!response.ok) throw new Error(json.error?.message || response.statusText);
    return json;
  });
  function createWindow() {
    window = new BrowserWindow({ width: 1380, height: 920, minWidth: 1040, minHeight: 700,
      title: 'Local AI API Proxy', backgroundColor: '#f5f8f6', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 14 },
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about', label: `About ${app.name}` }, { type: 'separator' },
      { role: 'hide', label: `Hide ${app.name}` }, { role: 'hideOthers', label: 'Hide Others' },
      { role: 'unhide', label: 'Show All' }, { type: 'separator' }, { role: 'quit', label: `Quit ${app.name}` }
    ] },
    { label: 'Edit', submenu: [
      { role: 'undo', label: 'Undo' }, { role: 'redo', label: 'Redo' }, { type: 'separator' },
      { role: 'cut', label: 'Cut' }, { role: 'copy', label: 'Copy' }, { role: 'paste', label: 'Paste' },
      { role: 'pasteAndMatchStyle', label: 'Paste and Match Style' }, { role: 'delete', label: 'Delete' },
      { type: 'separator' }, { role: 'selectAll', label: 'Select All' },
      { label: 'Speech', submenu: [{ role: 'startSpeaking', label: 'Start Speaking' }, { role: 'stopSpeaking', label: 'Stop Speaking' }] }
    ] },
    { label: 'View', submenu: [
      { role: 'reload', label: 'Reload' }, { role: 'forceReload', label: 'Force Reload' },
      { role: 'toggleDevTools', label: 'Toggle Developer Tools' }, { type: 'separator' },
      { role: 'resetZoom', label: 'Actual Size' }, { role: 'zoomIn', label: 'Zoom In' }, { role: 'zoomOut', label: 'Zoom Out' },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'Toggle Full Screen' }
    ] },
    { label: 'Window', submenu: [
      { role: 'minimize', label: 'Minimize' }, { role: 'zoom', label: 'Zoom' }, { role: 'close', label: 'Close Window' },
      { type: 'separator' }, { role: 'front', label: 'Bring All to Front' }
    ] }
  ]));
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  if (process.env.CODEX_LOCAL_SMOKE) {
    await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    try {
      if (process.argv.includes('--smoke-antigravity')) server.configure({ backend: 'antigravity' });
      await server.start();
      const state = await window.webContents.executeJavaScript('document.querySelector("#statusLabel").textContent');
      if (state !== 'Running') throw new Error(`Unexpected GUI status: ${state}`);
      if (process.argv.includes('--smoke-inference')) {
        const model = (server.settings.backend === 'antigravity' && server.models.find(m => m.model.endsWith('-low'))) || server.models.find(m => m.isDefault) || server.models[0];
        const post = async (endpoint, body) => {
          const response = await fetch(`http://127.0.0.1:${server.settings.port}/v1/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model.model, ...body }) });
          const text = await response.text();
          if (!response.ok) throw new Error(`${response.status}: ${text}`);
          return text;
        };
        const chat = await post('chat/completions', { stream: true, stream_options: { include_usage: true }, messages: [{ role: 'system', content: 'Reply briefly.' }, { role: 'user', content: 'Reply with exactly: connected' }] });
        if (!chat.includes('[DONE]') || !chat.includes('connected') || chat.includes('"error":')) throw new Error(`Chat stream failed: ${chat}`);
        const schema = { type: 'object', properties: { connected: { type: 'boolean' } }, required: ['connected'], additionalProperties: false };
        const response = JSON.parse(await post('responses', { input: 'Return connected true.', text: { format: { type: 'json_schema', name: 'connection', strict: true, schema } } }));
        if (!JSON.parse(response.output[0].content[0].text).connected) throw new Error('Structured response failed');
        const stream = await post('responses', { stream: true, input: 'Reply with exactly: ready' });
        if (!stream.includes('event: response.completed') || !stream.includes('ready')) throw new Error(`Responses stream failed: ${stream}`);
        await window.webContents.executeJavaScript(`document.querySelector('#testPrompt').focus();`);
        await new Promise(resolve => setTimeout(resolve, 100));
        await window.webContents.executeJavaScript(`if (document.activeElement !== document.querySelector('#testPrompt')) throw new Error('Playground did not receive focus');`);
        await new Promise(resolve => setTimeout(resolve, 100));
        console.log('REAL_INFERENCE_OK', JSON.stringify({ chatStream: true, responsesJSONSchema: true, responsesStream: true, usage: response.usage }));
      }
      await window.webContents.executeJavaScript(`(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        const form = document.querySelector('#settingsForm');
        if (Array.from(form.querySelectorAll('input,select')).some(input => !input.disabled)) throw new Error('All settings must be locked while running');
        if (document.querySelector('#saveSettings')) throw new Error('Settings must save automatically');
        if (!Array.from(form.elements.backend.options).some(o => o.value === 'antigravity')) throw new Error('Antigravity option missing');
        if (!form.closest('.sidebar')) throw new Error('Settings must be in the sidebar');
      })()`);
      window.show(); window.focus();
      await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      await new Promise(resolve => setTimeout(resolve, 200));
      if (process.env.CODEX_LOCAL_SCREENSHOT) {
        const image = await window.webContents.capturePage(undefined, { stayAwake: true }); fs.writeFileSync(process.env.CODEX_LOCAL_SCREENSHOT, image.toPNG());
      }
      console.log('GUI_SMOKE_OK', JSON.stringify({ models: server.models.length, state: server.state, label: state }));
    } catch (err) { console.error('GUI_SMOKE_FAILED', err); process.exitCode = 1; }
    await server.stop(); app.exit(process.exitCode || 0);
  }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (exiting || !server) return;
  event.preventDefault(); exiting = true; server.stop().finally(() => app.quit());
});
