const path = require('node:path');
const { LocalServer } = require('./server.cjs');
const server = new LocalServer({ directory: process.env.CODEX_LOCAL_DATA || path.resolve('.local-data') });
server.configure({
  ...(process.env.AI_BACKEND ? { backend: process.env.AI_BACKEND } : {}),
  ...(process.env.ANTIGRAVITY_BINARY ? { antigravityBinary: process.env.ANTIGRAVITY_BINARY } : {}),
  ...(process.env.PORT ? { port: Number(process.env.PORT) } : {}),
  ...(process.env.CODEX_BINARY ? { binary: process.env.CODEX_BINARY } : {}),
});
server.on('log', row => { if (row.duration !== undefined) console.log(`${row.time} ${row.method} ${row.path} ${row.status} ${row.duration}ms`); });
server.on('state', state => { if (state.state === 'error') console.error(state.error); });
server.start().then(state => console.log(`Local AI API Proxy: ${state.baseURL}\nModels: ${state.models.map(m => m.model).join(', ')}\nLogs: ${state.logDirectory}`)).catch(err => { console.error(err.message); process.exitCode = 1; });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.stop().finally(() => process.exit()));
