const { spawn } = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
const packaged = args.includes('--packaged');
const productName = require('../package.json').build.productName;
const outputDirectory = process.arch === 'x64' ? 'mac' : `mac-${process.arch}`;
const binary = packaged
  ? path.resolve('dist', outputDirectory, `${productName}.app`, 'Contents', 'MacOS', productName)
  : require('electron');
const child = spawn(binary, [...(packaged ? [] : ['.']), ...args.filter(arg => arg !== '--packaged')], { stdio: 'inherit' });
child.on('error', err => { console.error(err.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
