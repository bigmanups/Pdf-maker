const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');

const SUPPORTED = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'docx', 'txt', 'md', 'markdown', 'html', 'htm', 'csv', 'log', 'json'];

let mainWindow = null;
let pendingPaths = [];

function pathsFromArgv(argv) {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => !a.startsWith('-') && SUPPORTED.includes(path.extname(a).slice(1).toLowerCase()))
    .filter((a) => fsSync.existsSync(a));
}

async function readFiles(paths) {
  return Promise.all(paths.map(async (p) => ({ name: path.basename(p), path: p, data: await fs.readFile(p) })));
}

async function sendPaths(paths) {
  if (!paths.length || !mainWindow) return;
  mainWindow.webContents.send('open-paths', await readFiles(paths));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'PDF Maker',
    backgroundColor: '#f4f4f6',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    sendPaths(pendingPaths);
    pendingPaths = [];
  });
  mainWindow.on('closed', () => (mainWindow = null));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    sendPaths(pathsFromArgv(argv));
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    pendingPaths = pathsFromArgv(process.argv);
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

// ---------- File dialogs ----------

ipcMain.handle('open-files', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    title: 'Add files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Supported files', extensions: SUPPORTED },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] },
      { name: 'Documents', extensions: ['docx', 'txt', 'md', 'markdown', 'html', 'htm', 'csv'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (r.canceled) return [];
  return readFiles(r.filePaths);
});

ipcMain.handle('save-pdf', async (e, { data, defaultName }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, {
    title: 'Save PDF',
    defaultPath: path.join(app.getPath('documents'), defaultName || 'document.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePath) return null;
  await fs.writeFile(r.filePath, Buffer.from(data));
  return r.filePath;
});

ipcMain.handle('save-pdfs-to-folder', async (e, files) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a folder for the split pages',
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const dir = r.filePaths[0];
  for (const f of files) await fs.writeFile(path.join(dir, f.name), Buffer.from(f.data));
  return dir;
});

ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));

// ---------- Document -> PDF conversion ----------

const DOC_CSS = `
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #000; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; margin: 8px 0; }
  td, th { border: 1px solid #999; padding: 4px 6px; vertical-align: top; font-size: 10pt; }
  th { background: #eee; }
  pre { white-space: pre-wrap; word-wrap: break-word; font-family: Consolas, monospace; font-size: 10pt; margin: 0; }
  code { font-family: Consolas, monospace; }
`;

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const wrap = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>${DOC_CSS}</style></head><body>${body}</body></html>`;

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function toHtml(name, data) {
  const ext = path.extname(name).slice(1).toLowerCase();
  const buf = Buffer.from(data);
  const text = () => buf.toString('utf8').replace(/^﻿/, '');
  if (ext === 'docx') {
    const mammoth = require('mammoth');
    const r = await mammoth.convertToHtml({ buffer: buf });
    return wrap(r.value);
  }
  if (ext === 'md' || ext === 'markdown') {
    const { marked } = require('marked');
    return wrap(marked.parse(text()));
  }
  if (ext === 'html' || ext === 'htm') return text();
  if (ext === 'csv') {
    const [head = [], ...rows] = parseCsv(text());
    const tr = (cells, tag) => `<tr>${cells.map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join('')}</tr>`;
    return wrap(`<table>${tr(head, 'th')}${rows.map((r) => tr(r, 'td')).join('')}</table>`);
  }
  return wrap(`<pre>${escapeHtml(text())}</pre>`);
}

ipcMain.handle('convert-to-pdf', async (_e, { name, data, path: filePath }) => {
  const ext = path.extname(name).slice(1).toLowerCase();
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
  let tmp = null;
  try {
    // HTML files are loaded from their real location so relative images/styles still work.
    if ((ext === 'html' || ext === 'htm') && filePath && fsSync.existsSync(filePath)) {
      await win.loadFile(filePath);
    } else {
      tmp = path.join(os.tmpdir(), `pdfmaker-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
      await fs.writeFile(tmp, await toHtml(name, data), 'utf8');
      await win.loadFile(tmp);
    }
    return await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    });
  } finally {
    win.destroy();
    if (tmp) fs.unlink(tmp).catch(() => {});
  }
});
