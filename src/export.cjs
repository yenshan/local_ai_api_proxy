const fs = require('node:fs/promises');

async function exportCommunicationLogs({ parent, dialog, rows }) {
  // Capture the current communications before the save dialog opens.
  const communications = rows.filter(row => row.method === 'POST' && /^\/v1\/(chat\/completions|responses)(?:\?|$)/.test(row.path) && row.request).slice().reverse();
  const json = JSON.stringify(communications, null, 2);
  const result = await dialog.showSaveDialog(parent, {
    title: '通信ログをJSONで保存',
    defaultPath: `communication-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled) return false;
  await fs.writeFile(result.filePath, json, { encoding: 'utf8', mode: 0o600 });
  return true;
}

module.exports = { exportCommunicationLogs };
