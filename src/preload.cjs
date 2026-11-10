const { contextBridge, ipcRenderer } = require('electron');
const methods = ['snapshot','start','stop','configure','models','cancel','clear','open-logs','export','test-request'];
contextBridge.exposeInMainWorld('api', {
  call: (method, arg) => { if (!methods.includes(method)) return Promise.reject(new Error('Unknown method')); return ipcRenderer.invoke(method, arg); },
  on: (name, callback) => {
    if (!['state','log','reset','diagnostic'].includes(name)) return;
    const listener = (_, data) => callback(data); ipcRenderer.on(name, listener);
    return () => ipcRenderer.removeListener(name, listener);
  },
});
