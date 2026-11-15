const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportCommunicationLogs } = require('../src/export.cjs');

function directory(t) {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'communication-export-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  return target;
}
test('JSON export captures visible communications in display order with full data', async t => {
  const filePath = path.join(directory(t), '通信ログ.json');
  const oldest = { id: 'old', time: '2026-11-15T09:00:01Z', method: 'POST', path: '/v1/chat/completions', request: { messages: [{ role: 'user', content: 'こんにちは' }] }, response: { choices: [{ message: { content: '応答' } }] }, text: '応答', usage: { totalTokens: 12 }, events: [{ method: 'turn/completed' }], status: 'completed' };
  const latest = { id: 'new', time: '2026-11-15T09:00:02Z', method: 'POST', path: '/v1/responses?test=1', request: { input: '続けて' }, text: '生成途中', status: 'running' };
  const rows = [latest, { method: 'GET', path: '/v1/models', response: {} }, { method: 'POST', path: '/v1/chat/completions', request: null }, oldest, { method: 'GET', path: '/health' }];
  const parent = {};
  const dialog = { showSaveDialog: async (window, options) => {
    assert.equal(window, parent); assert.match(options.defaultPath, /^communication-logs-.*\.json$/);
    assert.deepEqual(options.filters, [{ name: 'JSON', extensions: ['json'] }]);
    latest.text = '生成完了';
    return { canceled: false, filePath };
  } };
  assert.equal(await exportCommunicationLogs({ parent, dialog, rows }), true);
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(json.map(row => row.id), ['old', 'new']);
  assert.deepEqual(json[0], oldest); assert.equal(json[1].text, '生成途中'); assert.equal(json[1].status, 'running');
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});
test('canceling JSON export does not create a file', async t => {
  const filePath = path.join(directory(t), 'cancelled.json');
  const dialog = { showSaveDialog: async () => ({ canceled: true, filePath }) };
  assert.equal(await exportCommunicationLogs({ dialog, rows: [] }), false);
  assert.equal(fs.existsSync(filePath), false);
});
test('JSON export propagates write failures', async t => {
  const filePath = directory(t);
  const dialog = { showSaveDialog: async () => ({ canceled: false, filePath }) };
  await assert.rejects(exportCommunicationLogs({ dialog, rows: [] }));
});
