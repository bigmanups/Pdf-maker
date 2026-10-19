const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFiles: () => ipcRenderer.invoke('open-files'),
  convertToPdf: (file) => ipcRenderer.invoke('convert-to-pdf', file),
  savePdf: (data, defaultName) => ipcRenderer.invoke('save-pdf', { data, defaultName }),
  savePdfsToFolder: (files) => ipcRenderer.invoke('save-pdfs-to-folder', files),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  onOpenPaths: (cb) => ipcRenderer.on('open-paths', (_e, files) => cb(files)),
});
