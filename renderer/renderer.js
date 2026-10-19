'use strict';

const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = '../node_modules/pdfjs-dist/build/pdf.worker.min.js';

const $ = (id) => document.getElementById(id);
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];
const CONVERT_EXT = ['docx', 'txt', 'md', 'markdown', 'html', 'htm', 'csv', 'log', 'json'];
const THUMB = 172;

// ---------- State ----------
// sources: loaded PDFs (every added file is turned into a PDF first)
// pages:   the working document, one entry per output page
const sources = new Map(); // id -> { name, bytes, pdf (pdf.js), lib (pdf-lib, lazy) }
let pages = []; // { uid, src, index, baseRot, rot, w, h, items: [], ver }
let selected = new Set();
let lastClicked = null;
let undoStack = [];
let idCounter = 1;
let verCounter = 1;
const newId = () => idCounter++;

const ext = (name) => {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
};
const baseName = (name) => name.replace(/\.[^.]+$/, '');
const totalRot = (p) => (p.baseRot + p.rot) % 360;
const selectedPages = () => pages.filter((p) => selected.has(p.uid));

function setStatus(msg, isError = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', isError);
}

function busy(on, text = 'Working…') {
  $('busy').classList.toggle('hidden', !on);
  $('busyText').textContent = text;
}

function snapshot() {
  undoStack.push(pages.map((p) => ({ ...p, items: p.items.map((i) => ({ ...i })) })));
  if (undoStack.length > 100) undoStack.shift();
  updateButtons();
}

function undo() {
  if (!undoStack.length) return setStatus('Nothing to undo');
  pages = undoStack.pop();
  selected = new Set([...selected].filter((u) => pages.some((p) => p.uid === u)));
  renderGrid();
  setStatus('Undone');
}

// ---------- Adding files ----------

async function readDroppedFiles(fileList) {
  return Promise.all(
    [...fileList].map(async (f) => ({ name: f.name, path: window.api.pathForFile(f), data: new Uint8Array(await f.arrayBuffer()) }))
  );
}

async function addFiles(files) {
  if (!files || !files.length) return;
  snapshot();
  let added = 0;
  const errors = [];
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    busy(true, `Adding ${f.name}${files.length > 1 ? ` (${k + 1} of ${files.length})` : ''}…`);
    try {
      const pdfBytes = await toPdfBytes({ ...f, data: new Uint8Array(f.data) });
      added += await addSource(f.name, pdfBytes);
    } catch (e) {
      console.error(e);
      errors.push(`${f.name} – ${friendlyError(e)}`);
    }
  }
  busy(false);
  if (!added) undoStack.pop();
  renderGrid();
  if (errors.length) setStatus(`Couldn't add: ${errors.join('; ')}`, true);
  else setStatus(`Added ${added} page${added === 1 ? '' : 's'} from ${files.length} file${files.length === 1 ? '' : 's'}`);
}

function friendlyError(e) {
  if (e && e.name === 'PasswordException') return 'the PDF is password protected';
  if (e && /Unsupported file type/.test(e.message)) return 'unsupported file type';
  return (e && e.message) || String(e);
}

async function toPdfBytes(f) {
  const e = ext(f.name);
  if (e === 'pdf') return f.data;
  if (IMAGE_EXT.includes(e)) return imageToPdf(f.data, e);
  if (CONVERT_EXT.includes(e)) return new Uint8Array(await window.api.convertToPdf({ name: f.name, data: f.data, path: f.path }));
  throw new Error('Unsupported file type');
}

async function imageToPdf(data, e) {
  const doc = await PDFDocument.create();
  let img = null;
  if (e === 'png') {
    try { img = await doc.embedPng(data); } catch { img = null; }
  }
  if (!img) {
    // Go through a canvas: handles webp/gif/bmp and applies the photo's EXIF rotation.
    const bmp = await createImageBitmap(new Blob([data]), { imageOrientation: 'from-image' });
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d');
    if (e !== 'png') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.drawImage(bmp, 0, 0);
    const type = e === 'png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((r) => c.toBlob(r, type, 0.92));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    img = type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  }
  // A4, orientation matching the image, image fitted inside a small margin
  const [W, H] = img.width > img.height ? [841.89, 595.28] : [595.28, 841.89];
  const m = 24;
  const s = Math.min((W - 2 * m) / img.width, (H - 2 * m) / img.height);
  const w = img.width * s;
  const h = img.height * s;
  doc.addPage([W, H]).drawImage(img, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
  return doc.save();
}

async function addSource(name, bytes) {
  const id = newId();
  // pdf.js takes ownership of the buffer it is given, so hand it a copy
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  sources.set(id, { name, bytes, pdf, lib: null });
  for (let i = 0; i < pdf.numPages; i++) {
    const pg = await pdf.getPage(i + 1);
    const vp = pg.getViewport({ scale: 1, rotation: 0 });
    pages.push({ uid: newId(), src: id, index: i, baseRot: pg.rotate || 0, rot: 0, w: vp.width, h: vp.height, items: [], ver: 0 });
  }
  return pdf.numPages;
}

// ---------- Rendering ----------

async function renderPage(p, longestPx) {
  const page = await sources.get(p.src).pdf.getPage(p.index + 1);
  const rotation = totalRot(p);
  const v1 = page.getViewport({ scale: 1, rotation });
  const vp = page.getViewport({ scale: longestPx / Math.max(v1.width, v1.height), rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { canvas, vp };
}

// Text uses the three PDF standard font families so what you see matches what gets saved.
const FONT_STACKS = {
  sans: 'Helvetica, Arial, sans-serif',
  serif: '"Times New Roman", Times, serif',
  mono: '"Courier New", Courier, monospace',
};
const STD_FONTS = {
  sans: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  serif: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  mono: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};

function fontCss(px, it = {}) {
  return `${it.italic ? 'italic ' : ''}${it.bold ? 'bold ' : ''}${px}px ${FONT_STACKS[it.font] || FONT_STACKS.sans}`;
}

function stdFontName(it) {
  return StandardFonts[(STD_FONTS[it.font] || STD_FONTS.sans)[(it.bold ? 1 : 0) + (it.italic ? 2 : 0)]];
}

// Item types:
//   box  – white-out rectangle
//   text – added text
//   edit – replaced original text: a cover in the page's background colour plus new text
// Items are stored in PDF user-space coordinates so they stay attached to the page content.
function drawItems(ctx, vp, items, rotation) {
  for (const it of items) {
    if (it.type === 'box' || it.type === 'edit') {
      const [x1, y1] = vp.convertToViewportPoint(it.x1, it.y1);
      const [x2, y2] = vp.convertToViewportPoint(it.x2, it.y2);
      ctx.fillStyle = it.type === 'edit' ? it.bg : '#fff';
      ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      if (it.type === 'box') continue;
    }
    if (it._editing) continue; // the inline text box is showing it instead
    const [x, y] = vp.convertToViewportPoint(it.x, it.y);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(((rotation - it.rot) * Math.PI) / 180);
    ctx.font = fontCss(it.size * vp.scale, it);
    ctx.fillStyle = it.color;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(it.text, 0, 0);
    ctx.restore();
  }
}

const keyOf = (p) => `${p.rot}:${p.ver}`;
const cards = new Map(); // uid -> element

const observer = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      en.target._visible = en.isIntersecting;
      if (en.isIntersecting) renderThumb(en.target);
    }
  },
  { root: $('main'), rootMargin: '600px' }
);

function placeholder(p) {
  const r = totalRot(p) % 180 === 0;
  const w = r ? p.w : p.h;
  const h = r ? p.h : p.w;
  const s = THUMB / Math.max(w, h);
  const ph = document.createElement('div');
  ph.className = 'ph';
  ph.style.width = `${Math.round(w * s)}px`;
  ph.style.height = `${Math.round(h * s)}px`;
  return ph;
}

function makeCard(p) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.uid = p.uid;
  el.innerHTML = `
    <div class="thumb"></div>
    <div class="mini">
      <button data-act="rotl" title="Rotate left">⟲</button>
      <button data-act="rotr" title="Rotate right">⟳</button>
      <button data-act="del" title="Delete">✕</button>
    </div>
    <div class="meta"><span class="num"></span><span class="src"></span></div>`;
  el.querySelector('.src').textContent = sources.get(p.src).name;
  el.querySelector('.src').title = sources.get(p.src).name;
  el.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    const u = +el.dataset.uid;
    if (act) {
      e.stopPropagation();
      if (act === 'del') deletePages([u]);
      else rotatePages([u], act === 'rotl' ? -90 : 90);
      return;
    }
    onCardClick(e, u);
  });
  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    openEditor(pages.findIndex((x) => x.uid === +el.dataset.uid));
  });
  el.addEventListener('dragstart', (e) => onDragStart(e, el));
  el.addEventListener('dragend', onDragEnd);
  return el;
}

async function renderThumb(el) {
  const p = pages.find((x) => x.uid === +el.dataset.uid);
  if (!p) return;
  const key = el.dataset.key;
  if (el.dataset.rendered === key || el._rendering === key) return;
  el._rendering = key;
  try {
    const dpr = window.devicePixelRatio || 1;
    const { canvas, vp } = await renderPage(p, THUMB * dpr);
    drawItems(canvas.getContext('2d'), vp, p.items, totalRot(p));
    if (el.dataset.key !== key) return;
    canvas.style.width = `${canvas.width / dpr}px`;
    canvas.style.height = `${canvas.height / dpr}px`;
    el.querySelector('.thumb').replaceChildren(canvas);
    el.dataset.rendered = key;
  } catch (e) {
    console.error(e);
  } finally {
    if (el._rendering === key) el._rendering = null;
  }
}

function renderGrid() {
  const grid = $('grid');
  const alive = new Set(pages.map((p) => p.uid));
  for (const [u, el] of cards) {
    if (!alive.has(u)) {
      observer.unobserve(el);
      el.remove();
      cards.delete(u);
    }
  }
  pages.forEach((p, i) => {
    let el = cards.get(p.uid);
    if (!el) {
      el = makeCard(p);
      cards.set(p.uid, el);
      observer.observe(el);
    }
    if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
    el.querySelector('.num').textContent = `${i + 1}`;
    const edited = p.items.length > 0;
    let badge = el.querySelector('.badge');
    if (edited && !badge) {
      badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'edited';
      el.appendChild(badge);
    } else if (!edited && badge) badge.remove();
    const key = keyOf(p);
    if (el.dataset.key !== key) {
      el.dataset.key = key;
      el.dataset.rendered = '';
      el.querySelector('.thumb').replaceChildren(placeholder(p));
      if (el._visible) renderThumb(el);
    }
  });
  $('empty').classList.toggle('hidden', pages.length > 0);
  renderSelection();
}

function renderSelection() {
  for (const [u, el] of cards) el.classList.toggle('selected', selected.has(u));
  const n = pages.length;
  $('count').textContent = n ? `${n} page${n === 1 ? '' : 's'}${selected.size ? ` · ${selected.size} selected` : ''}` : '';
  updateButtons();
}

function updateButtons() {
  document.querySelectorAll('[data-needs-sel]').forEach((b) => (b.disabled = selected.size === 0));
  document.querySelectorAll('[data-needs-pages]').forEach((b) => (b.disabled = pages.length === 0));
  $('btnUndo').disabled = undoStack.length === 0;
}

// ---------- Selection ----------

function onCardClick(e, u) {
  if (e.shiftKey && lastClicked != null) {
    const a = pages.findIndex((p) => p.uid === lastClicked);
    const b = pages.findIndex((p) => p.uid === u);
    if (!(e.ctrlKey || e.metaKey)) selected.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(pages[i].uid);
  } else if (e.ctrlKey || e.metaKey) {
    selected.has(u) ? selected.delete(u) : selected.add(u);
    lastClicked = u;
  } else {
    selected = new Set([u]);
    lastClicked = u;
  }
  renderSelection();
}

$('grid').addEventListener('click', (e) => {
  if (e.target === $('grid')) {
    selected.clear();
    renderSelection();
  }
});

// ---------- Drag to reorder ----------

let dragUids = null;
let dropTarget = null; // { uid, after } or { uid: null } for end

function onDragStart(e, el) {
  const u = +el.dataset.uid;
  if (!selected.has(u)) {
    selected = new Set([u]);
    lastClicked = u;
    renderSelection();
  }
  dragUids = pages.filter((p) => selected.has(p.uid)).map((p) => p.uid);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/x-pdfmaker-page', 'x');
  requestAnimationFrame(() => dragUids.forEach((id) => cards.get(id)?.classList.add('dragging')));
}

function clearDropMarks() {
  document.querySelectorAll('.drop-before, .drop-after').forEach((c) => c.classList.remove('drop-before', 'drop-after'));
}

function onDragEnd() {
  document.querySelectorAll('.card.dragging').forEach((c) => c.classList.remove('dragging'));
  clearDropMarks();
  dragUids = null;
  dropTarget = null;
}

$('grid').addEventListener('dragover', (e) => {
  if (!dragUids) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const card = e.target.closest('.card');
  clearDropMarks();
  if (card) {
    const r = card.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    card.classList.add(after ? 'drop-after' : 'drop-before');
    dropTarget = { uid: +card.dataset.uid, after };
  } else {
    const last = $('grid').lastElementChild;
    if (last) last.classList.add('drop-after');
    dropTarget = { uid: null };
  }
});

$('grid').addEventListener('drop', (e) => {
  if (!dragUids) return;
  e.preventDefault();
  e.stopPropagation();
  if (dropTarget && !(dropTarget.uid != null && dragUids.includes(dropTarget.uid))) {
    snapshot();
    const moving = pages.filter((p) => dragUids.includes(p.uid));
    const rest = pages.filter((p) => !dragUids.includes(p.uid));
    let idx = rest.length;
    if (dropTarget.uid != null) idx = rest.findIndex((p) => p.uid === dropTarget.uid) + (dropTarget.after ? 1 : 0);
    rest.splice(idx, 0, ...moving);
    pages = rest;
    renderGrid();
    setStatus(`Moved ${moving.length} page${moving.length === 1 ? '' : 's'}`);
  }
  onDragEnd();
});

// ---------- External file drop ----------

let dragDepth = 0;
const isFileDrag = (e) => !dragUids && [...(e.dataTransfer?.types || [])].includes('Files');

document.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  dragDepth++;
  $('dropOverlay').classList.remove('hidden');
});
document.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('dropOverlay').classList.add('hidden');
  }
});
document.addEventListener('dragover', (e) => {
  if (isFileDrag(e)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});
document.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').classList.add('hidden');
  if (!$('editor').classList.contains('hidden')) return;
  addFiles(await readDroppedFiles(e.dataTransfer.files));
});

// ---------- Page operations ----------

function targetUids() {
  return pages.filter((p) => selected.has(p.uid)).map((p) => p.uid);
}

function rotatePages(uids, delta) {
  if (!uids.length) return setStatus('Select one or more pages first');
  snapshot();
  for (const p of pages) {
    if (uids.includes(p.uid)) {
      p.rot = (p.rot + delta + 360) % 360;
      p.ver = ++verCounter;
    }
  }
  renderGrid();
  setStatus(`Rotated ${uids.length} page${uids.length === 1 ? '' : 's'}`);
}

function deletePages(uids) {
  if (!uids.length) return setStatus('Select one or more pages first');
  snapshot();
  pages = pages.filter((p) => !uids.includes(p.uid));
  uids.forEach((u) => selected.delete(u));
  renderGrid();
  setStatus(`Deleted ${uids.length} page${uids.length === 1 ? '' : 's'} (Ctrl+Z to undo)`);
}

function duplicatePages(uids) {
  if (!uids.length) return setStatus('Select one or more pages first');
  snapshot();
  const out = [];
  const fresh = new Set();
  for (const p of pages) {
    out.push(p);
    if (uids.includes(p.uid)) {
      const copy = { ...p, uid: newId(), items: p.items.map((i) => ({ ...i })) };
      out.push(copy);
      fresh.add(copy.uid);
    }
  }
  pages = out;
  selected = fresh;
  renderGrid();
  setStatus(`Duplicated ${uids.length} page${uids.length === 1 ? '' : 's'}`);
}

function clearAll() {
  if (!pages.length) return;
  snapshot();
  pages = [];
  selected.clear();
  renderGrid();
  setStatus('Cleared all pages (Ctrl+Z to undo)');
}

// ---------- Export ----------

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

async function buildPdf(list) {
  const out = await PDFDocument.create();
  // Copy pages in one batch per source so shared fonts/images are only stored once.
  const bySrc = new Map();
  list.forEach((p, i) => {
    if (!bySrc.has(p.src)) bySrc.set(p.src, []);
    bySrc.get(p.src).push(i);
  });
  const copied = new Array(list.length);
  for (const [sid, idxs] of bySrc) {
    const src = sources.get(sid);
    if (!src.lib) src.lib = await PDFDocument.load(src.bytes, { ignoreEncryption: true });
    const cps = await out.copyPages(src.lib, idxs.map((i) => list[i].index));
    idxs.forEach((i, k) => (copied[i] = cps[k]));
  }
  const fonts = {};
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const page = out.addPage(copied[i]);
    page.setRotation(degrees(totalRot(p)));
    const replaced = p.items.filter((it) => it.type === 'edit');
    if (replaced.length) {
      try {
        TextRemover.removeText(out, page, replaced);
      } catch (e) {
        console.warn('Could not remove original text; it stays covered instead', e);
      }
    }
    for (const it of p.items) {
      if (it.type === 'box' || it.type === 'edit') {
        page.drawRectangle({
          x: Math.min(it.x1, it.x2),
          y: Math.min(it.y1, it.y2),
          width: Math.abs(it.x2 - it.x1),
          height: Math.abs(it.y2 - it.y1),
          color: it.type === 'edit' ? hexToRgb(it.bg) : rgb(1, 1, 1),
        });
      }
      if (it.type !== 'box' && it.text.trim()) {
        const name = stdFontName(it);
        const font = fonts[name] || (fonts[name] = await out.embedFont(name));
        // Standard fonts only cover Western characters; swap anything else for '?'
        const safe = [...it.text].map((ch) => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');
        page.drawText(safe, { x: it.x, y: it.y, size: it.size, font, color: hexToRgb(it.color), rotate: degrees(it.rot) });
      }
    }
  }
  out.setCreator('PDF Maker');
  out.setProducer('PDF Maker');
  return out.save();
}

function defaultName(suffix = '') {
  const first = pages[0] && sources.get(pages[0].src);
  return `${first ? baseName(first.name) : 'document'}${suffix}.pdf`;
}

async function saveList(list, name) {
  if (!list.length) return;
  busy(true, `Building PDF (${list.length} page${list.length === 1 ? '' : 's'})…`);
  try {
    const bytes = await buildPdf(list);
    busy(false);
    const saved = await window.api.savePdf(bytes, name);
    if (saved) {
      setStatus(`Saved ${saved}`);
      window.api.showInFolder(saved);
    } else setStatus('Save cancelled');
  } catch (e) {
    console.error(e);
    setStatus(`Save failed: ${friendlyError(e)}`, true);
  } finally {
    busy(false);
  }
}

async function splitPages() {
  const list = selected.size ? selectedPages() : pages;
  if (!list.length) return;
  const base = baseName(defaultName());
  try {
    const files = [];
    for (let i = 0; i < list.length; i++) {
      busy(true, `Splitting page ${i + 1} of ${list.length}…`);
      const n = pages.indexOf(list[i]) + 1;
      files.push({ name: `${base}-page-${String(n).padStart(String(pages.length).length, '0')}.pdf`, data: await buildPdf([list[i]]) });
    }
    busy(false);
    const dir = await window.api.savePdfsToFolder(files);
    setStatus(dir ? `Saved ${files.length} files to ${dir}` : 'Split cancelled');
  } catch (e) {
    console.error(e);
    setStatus(`Split failed: ${friendlyError(e)}`, true);
  } finally {
    busy(false);
  }
}

// ---------- Page editor ----------

const ed = {
  i: 0,
  tool: 'edit',
  page: null, // pdf.js page being edited
  lines: [], // existing text lines found on the page
  hover: null, // text line under the mouse (Edit text tool)
  inline: null, // { it, input, isNew, orig } while typing directly on the page
  style: { font: 'sans', bold: false, italic: false },
  sel: null, // selected item
  vp: null,
  dpr: 1, // canvas pixels per CSS pixel
  drag: null,
  dirty: false,
  rotation: 0,
  fit: 1, // CSS px per PDF unit when the page fits the window
  zoom: 1, // multiplier on top of fit
  token: 0,
  task: null,
  zoomTimer: null,
  pan: null,
  space: false,
};
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
const MAX_CANVAS_PX = 40e6;

function edPage() {
  return pages[ed.i];
}

function openEditor(i) {
  if (!pages.length) return;
  if (i == null || i < 0) {
    const firstSel = pages.findIndex((p) => selected.has(p.uid));
    i = firstSel >= 0 ? firstSel : 0;
  }
  snapshot();
  ed.dirty = false;
  ed.i = i;
  ed.sel = null;
  ed.zoom = 1;
  $('editor').classList.remove('hidden');
  setTool(ed.tool);
  loadEditorPage();
}

function closeEditor() {
  finishInlineEdit();
  if (!ed.dirty) undoStack.pop();
  $('editor').classList.add('hidden');
  ed.sel = null;
  renderGrid();
  if (ed.dirty) setStatus('Page edits applied (Ctrl+Z to undo)');
}

// refit: recompute the "fit to window" scale (new page / window resize).
// Without refit (after zooming) the old render stays on screen until the sharper one is ready.
async function loadEditorPage(refit = true) {
  finishInlineEdit();
  const token = ++ed.token;
  const p = edPage();
  $('edPageNo').textContent = `Page ${ed.i + 1} / ${pages.length}`;
  $('edPrev').disabled = ed.i === 0;
  $('edNext').disabled = ed.i === pages.length - 1;
  updateZoomLabel();
  const stage = $('edStage');
  const rotation = totalRot(p);
  const page = await sources.get(p.src).pdf.getPage(p.index + 1);
  if (token !== ed.token) return;
  const v1 = page.getViewport({ scale: 1, rotation });
  if (refit) {
    const fit = Math.min((stage.clientWidth - 40) / v1.width, (stage.clientHeight - 40) / v1.height);
    ed.fit = Math.max(0.1, Math.min(fit, 4));
    ed.page = page;
    ed.lines = [];
    ed.hover = null;
    page.getTextContent().then((tc) => {
      if (ed.page === page) ed.lines = groupTextLines(tc);
    }).catch((e) => console.error(e));
  }
  const css = ed.fit * ed.zoom; // CSS px per PDF unit
  let dpr = window.devicePixelRatio || 1;
  // Keep huge zoom levels from creating canvases too big to allocate
  const area = v1.width * v1.height * (css * dpr) ** 2;
  if (area > MAX_CANVAS_PX) dpr *= Math.sqrt(MAX_CANVAS_PX / area);
  const vp = page.getViewport({ scale: css * dpr, rotation });

  const commit = () => {
    const base = $('edBase');
    const overlay = $('edOverlay');
    base.width = overlay.width = Math.round(vp.width);
    base.height = overlay.height = Math.round(vp.height);
    for (const c of [base, overlay]) {
      c.style.width = `${v1.width * css}px`;
      c.style.height = `${v1.height * css}px`;
    }
    Object.assign(ed, { vp, dpr, rotation });
  };
  if (refit) {
    commit();
    const ctx = $('edBase').getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, vp.width, vp.height);
    drawOverlay();
    stage.scrollTo(0, 0);
  }

  const off = document.createElement('canvas');
  off.width = Math.round(vp.width);
  off.height = Math.round(vp.height);
  const octx = off.getContext('2d');
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, off.width, off.height);
  if (ed.task) ed.task.cancel();
  const task = page.render({ canvasContext: octx, viewport: vp });
  ed.task = task;
  try {
    await task.promise;
  } catch (e) {
    if (e && e.name === 'RenderingCancelledException') return;
    throw e;
  }
  if (token !== ed.token) return;
  if (!refit) commit();
  $('edBase').getContext('2d').drawImage(off, 0, 0);
  drawOverlay();
}

// ---------- Editor zoom & pan ----------

function updateZoomLabel() {
  $('edZoom').textContent = `${Math.round(ed.zoom * 100)}%`;
}

// Zoom keeping the point under (cx, cy) fixed; defaults to the centre of the view.
function setZoom(z, cx, cy) {
  z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  if (Math.abs(z - ed.zoom) < 1e-4 || !ed.vp) return;
  finishInlineEdit();
  const stage = $('edStage');
  const wrap = $('edWrap');
  const r = wrap.getBoundingClientRect();
  if (cx == null) {
    const s = stage.getBoundingClientRect();
    cx = s.left + s.width / 2;
    cy = s.top + s.height / 2;
  }
  const fx = (cx - r.left) / r.width;
  const fy = (cy - r.top) / r.height;
  const w = (r.width * z) / ed.zoom;
  const h = (r.height * z) / ed.zoom;
  ed.zoom = z;
  // Stretch the current render straight away for smooth feedback, then re-render sharply.
  for (const c of [$('edBase'), $('edOverlay')]) {
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
  }
  const nr = wrap.getBoundingClientRect();
  stage.scrollLeft += nr.left + fx * w - cx;
  stage.scrollTop += nr.top + fy * h - cy;
  updateZoomLabel();
  clearTimeout(ed.zoomTimer);
  ed.zoomTimer = setTimeout(() => loadEditorPage(false), 120);
}

$('edStage').addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // lines -> pixels
    setZoom(ed.zoom * Math.exp(-delta * 0.0015), e.clientX, e.clientY);
  },
  { passive: false }
);

// Pan: drag with the middle or right mouse button, or hold Space and drag.
$('edStage').addEventListener('pointerdown', (e) => {
  if (!(e.button === 1 || e.button === 2 || (e.button === 0 && ed.space))) return;
  e.preventDefault();
  const stage = $('edStage');
  ed.pan = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
  stage.setPointerCapture(e.pointerId);
  stage.classList.add('panning');
});
$('edStage').addEventListener('pointermove', (e) => {
  if (!ed.pan) return;
  const stage = $('edStage');
  stage.scrollLeft = ed.pan.left - (e.clientX - ed.pan.x);
  stage.scrollTop = ed.pan.top - (e.clientY - ed.pan.y);
});
$('edStage').addEventListener('pointerup', () => {
  ed.pan = null;
  $('edStage').classList.remove('panning');
});
$('edStage').addEventListener('mousedown', (e) => {
  if (e.button === 1) e.preventDefault(); // stop Chromium's autoscroll
});
$('edStage').addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    ed.space = false;
    $('edStage').classList.remove('pan-ready');
  }
});

$('edZoomIn').addEventListener('click', () => setZoom(ed.zoom * 1.25));
$('edZoomOut').addEventListener('click', () => setZoom(ed.zoom / 1.25));
$('edZoomFit').addEventListener('click', () => {
  ed.zoom = 1;
  loadEditorPage();
});

// ---------- Existing text detection ----------

// pdf.js gives text in fragments (often single words). Join fragments that sit on the same
// baseline and close together into lines, each described in its own rotated frame:
// u runs along the text, v is the baseline offset perpendicular to it.
function groupTextLines(tc) {
  const lines = [];
  let cur = null;
  for (const t of tc.items) {
    if (!t.str || !t.transform) continue;
    const [a, b, c, d, e, f] = t.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b);
    if (size < 1) continue;
    const ang = Math.atan2(b, a);
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const u = e * cos + f * sin;
    const v = -e * sin + f * cos;
    const st = tc.styles[t.fontName] || {};
    const ok =
      cur &&
      Math.abs(ang - cur.ang) < 0.02 &&
      Math.abs(v - cur.v) < 0.3 * cur.size &&
      size / cur.size > 0.75 && size / cur.size < 1.33 &&
      u - cur.u1 > -0.5 * cur.size && u - cur.u1 < 0.9 * cur.size;
    if (ok) {
      if (u - cur.u1 > 0.15 * cur.size && !cur.str.endsWith(' ') && !t.str.startsWith(' ')) cur.str += ' ';
      cur.str += t.str;
      cur.u1 = Math.max(cur.u1, u + t.width);
      cur.size = Math.max(cur.size, size);
    } else {
      let asc = st.ascent;
      let desc = st.descent;
      if (!(asc > 0.5 && asc < 1.3)) asc = 0.9;
      if (!(desc < 0 && desc > -0.6)) desc = -0.22;
      cur = { str: t.str, ang, cos, sin, u0: u, u1: u + t.width, v, size, asc, desc, fontName: t.fontName, family: st.fontFamily || '' };
      lines.push(cur);
    }
  }
  return lines.filter((l) => l.str.trim() && l.u1 > l.u0);
}

const fromLocal = (l, u, v) => [u * l.cos - v * l.sin, u * l.sin + v * l.cos];

function lineCorners(l, pad = 0) {
  const lo = l.v + l.desc * l.size - pad;
  const hi = l.v + l.asc * l.size + pad;
  return [[l.u0 - pad, lo], [l.u1 + pad, lo], [l.u1 + pad, hi], [l.u0 - pad, hi]].map(([u, v]) => fromLocal(l, u, v));
}

function lineAt(pdfX, pdfY) {
  for (const l of ed.lines) {
    const u = pdfX * l.cos + pdfY * l.sin;
    const v = -pdfX * l.sin + pdfY * l.cos;
    const pad = l.size * 0.15;
    if (u >= l.u0 - pad && u <= l.u1 + pad && v >= l.v + l.desc * l.size - pad && v <= l.v + l.asc * l.size + pad) return l;
  }
  return null;
}

// Guess a matching standard font from the embedded font's name, e.g. "ABCDEF+Calibri-BoldItalic".
function guessFont(l) {
  let name = '';
  let obj = null;
  try {
    if (ed.page.commonObjs.has(l.fontName)) obj = ed.page.commonObjs.get(l.fontName);
    name = ((obj && obj.name) || '').replace(/^[A-Z]{6}\+/, '');
  } catch {}
  const bold = /bold|black|heavy|semibold|demi/i.test(name) || !!(obj && (obj.bold || obj.black));
  const italic = /italic|oblique/i.test(name) || !!(obj && obj.italic);
  let font = 'sans';
  if (/courier|mono|consol|code/i.test(name) || l.family === 'monospace') font = 'mono';
  else if (/sans|arial|helvetica|calibri|verdana|segoe|tahoma|roboto|open|aptos|lato|inter/i.test(name)) font = 'sans';
  else if (/times|georgia|garamond|cambria|serif|roman|book|minion|palatino|baskerville/i.test(name) || l.family === 'serif') font = 'serif';
  return { font, bold, italic };
}

const toHex = (r, g, b) => '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');

// Read the rendered page: background = median colour just around the text,
// text colour = the pixel inside that differs most from the background.
function sampleColors(x1, y1, x2, y2) {
  const base = $('edBase');
  const [ax, ay] = ed.vp.convertToViewportPoint(x1, y1);
  const [bx, by] = ed.vp.convertToViewportPoint(x2, y2);
  const m = Math.max(2, Math.round(3 * ed.dpr));
  const ix0 = Math.min(ax, bx), ix1 = Math.max(ax, bx), iy0 = Math.min(ay, by), iy1 = Math.max(ay, by);
  const X0 = Math.max(0, Math.floor(ix0) - m), Y0 = Math.max(0, Math.floor(iy0) - m);
  const X1 = Math.min(base.width, Math.ceil(ix1) + m), Y1 = Math.min(base.height, Math.ceil(iy1) + m);
  if (X1 - X0 < 1 || Y1 - Y0 < 1) return { bg: '#ffffff', fg: '#000000' };
  const data = base.getContext('2d').getImageData(X0, Y0, X1 - X0, Y1 - Y0).data;
  const ring = [[], [], []];
  const inside = [];
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      const k = ((y - Y0) * (X1 - X0) + (x - X0)) * 4;
      if (x < ix0 || x >= ix1 || y < iy0 || y >= iy1) {
        ring[0].push(data[k]); ring[1].push(data[k + 1]); ring[2].push(data[k + 2]);
      } else inside.push(k);
    }
  }
  const median = (arr) => (arr.length ? arr.sort((p, q) => p - q)[arr.length >> 1] : 255);
  const bg = ring.map(median);
  let best = 0;
  let fg = [0, 0, 0];
  for (const k of inside) {
    const dist = Math.abs(data[k] - bg[0]) + Math.abs(data[k + 1] - bg[1]) + Math.abs(data[k + 2] - bg[2]);
    if (dist > best) {
      best = dist;
      fg = [data[k], data[k + 1], data[k + 2]];
    }
  }
  return { bg: toHex(...bg), fg: best > 40 ? toHex(...fg) : '#000000' };
}

function makeEditItem(l) {
  const pts = lineCorners(l, l.size * 0.06);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x1, y1, x2, y2] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const { bg, fg } = sampleColors(x1, y1, x2, y2);
  const [x, y] = fromLocal(l, l.u0, l.v);
  return {
    type: 'edit',
    x1, y1, x2, y2,
    bg,
    text: l.str.replace(/\s+$/, ''),
    x, y,
    size: Math.round(l.size * 10) / 10,
    color: fg,
    rot: (l.ang * 180) / Math.PI,
    ...guessFont(l),
  };
}

// ---------- Item geometry (canvas pixels) ----------

function rectBounds(it) {
  const [x1, y1] = ed.vp.convertToViewportPoint(it.x1, it.y1);
  const [x2, y2] = ed.vp.convertToViewportPoint(it.x2, it.y2);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

function textBounds(it) {
  const [x, y] = ed.vp.convertToViewportPoint(it.x, it.y);
  const ctx = $('edOverlay').getContext('2d');
  const px = it.size * ed.vp.scale;
  ctx.font = fontCss(px, it);
  const w = Math.max(ctx.measureText(it.text || ' ').width, px * 0.5);
  const a = ((ed.rotation - it.rot) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const pts = [[0, -px * 0.95], [w, -px * 0.95], [w, px * 0.25], [0, px * 0.25]].map(([u, v]) => [x + u * cos - v * sin, y + u * sin + v * cos]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function itemBounds(it) {
  if (it.type === 'box') return rectBounds(it);
  const t = textBounds(it);
  if (it.type !== 'edit') return t;
  const r = rectBounds(it);
  const x = Math.min(r.x, t.x);
  const y = Math.min(r.y, t.y);
  return { x, y, w: Math.max(r.x + r.w, t.x + t.w) - x, h: Math.max(r.y + r.h, t.y + t.h) - y };
}

function drawOverlay() {
  const c = $('edOverlay');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const p = edPage();
  drawItems(ctx, ed.vp, p.items, ed.rotation);
  if (ed.hover && ed.tool === 'edit' && !ed.inline) {
    const pts = lineCorners(ed.hover, ed.hover.size * 0.08).map(([x, y]) => ed.vp.convertToViewportPoint(x, y));
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(47,111,214,0.12)';
    ctx.strokeStyle = '#2f6fd6';
    ctx.lineWidth = 1.5 * ed.dpr;
    ctx.fill();
    ctx.stroke();
  }
  ctx.setLineDash([6 * ed.dpr, 4 * ed.dpr]);
  ctx.lineWidth = 1.5 * ed.dpr;
  for (const it of p.items) {
    if (it._editing) continue;
    if (it === ed.sel || it.type === 'box') {
      const b = itemBounds(it);
      const pad = 3 * ed.dpr;
      ctx.strokeStyle = it === ed.sel ? '#2f6fd6' : 'rgba(0,0,0,0.25)';
      ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    }
  }
  if (ed.drag && ed.drag.kind === 'newbox') {
    const [x1, y1] = ed.vp.convertToViewportPoint(ed.drag.start[0], ed.drag.start[1]);
    const [x2, y2] = ed.vp.convertToViewportPoint(ed.drag.cur[0], ed.drag.cur[1]);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.strokeStyle = '#2f6fd6';
    ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  }
  ctx.setLineDash([]);
  $('edDelete').disabled = !ed.sel;
}

function markEdited() {
  const p = edPage();
  p.ver = ++verCounter;
  ed.dirty = true;
  drawOverlay();
}

function setTool(t) {
  finishInlineEdit();
  ed.tool = t;
  ed.hover = null;
  document.querySelectorAll('#toolSeg button').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  $('edOverlay').className = `tool-${t}`;
  $('edHint').textContent = {
    edit: 'Click any text on the page and type to change it. Enter to finish, Esc to cancel, clear it to delete the text.',
    select: 'Click an item you added or changed to select it, drag to move it, Del to remove it. Double-click to retype.',
    text: 'Click anywhere on the page and type to add new text.',
    box: 'Drag a rectangle over anything you want to cover up.',
  }[t] + '   ·   Mouse wheel zooms, right-drag or Space+drag pans.';
  if (ed.vp) drawOverlay();
}

const isTextItem = (it) => it && (it.type === 'text' || it.type === 'edit');

function syncStyleControls() {
  $('edFont').value = ed.style.font;
  $('edBold').classList.toggle('active', ed.style.bold);
  $('edItalic').classList.toggle('active', ed.style.italic);
}

function selectItem(it) {
  ed.sel = it;
  if (isTextItem(it)) {
    $('edText').value = it.text;
    $('edSize').value = it.size;
    $('edColor').value = it.color;
    ed.style = { font: it.font || 'sans', bold: !!it.bold, italic: !!it.italic };
    syncStyleControls();
  }
  drawOverlay();
}

// ---------- Typing directly on the page ----------

function positionInline() {
  const s = ed.inline;
  if (!s) return;
  const { it, input } = s;
  const c = $('edOverlay');
  const k = c.clientWidth / c.width; // canvas px -> CSS px
  const [x, y] = ed.vp.convertToViewportPoint(it.x, it.y);
  const px = it.size * ed.vp.scale * k;
  const ctx = c.getContext('2d');
  ctx.font = fontCss(px, it);
  const w = ctx.measureText(input.value || ' ').width;
  Object.assign(input.style, {
    left: `${x * k}px`,
    top: `${y * k - px}px`,
    width: `${w + px * 1.5 + 4}px`,
    height: `${px * 1.25}px`,
    font: fontCss(px, it),
    lineHeight: `${px * 1.25}px`,
    color: it.color,
    background: it.type === 'edit' ? it.bg : 'rgba(255,255,255,0.8)',
    transformOrigin: `0 ${px}px`,
    transform: `rotate(${ed.rotation - it.rot}deg)`,
  });
}

function startInlineEdit(it, isNew = false) {
  finishInlineEdit();
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-edit';
  input.spellcheck = true;
  input.value = it.text;
  ed.inline = { it, input, isNew, orig: it.text };
  it._editing = true;
  selectItem(it);
  $('edWrap').appendChild(input);
  positionInline();
  input.addEventListener('input', () => {
    it.text = input.value;
    $('edText').value = input.value;
    positionInline();
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finishInlineEdit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finishInlineEdit(false); }
  });
  input.addEventListener('blur', () => finishInlineEdit(true));
  drawOverlay();
  input.focus();
  input.select();
}

function finishInlineEdit(commit = true) {
  const s = ed.inline;
  if (!s) return;
  ed.inline = null;
  const { it, input, isNew, orig } = s;
  delete it._editing;
  input.remove();
  if (!commit) it.text = orig;
  const items = edPage().items;
  // A new edit that ended up unchanged (or new added text left empty) is dropped
  const drop = isNew && (it.type === 'edit' ? it.text === orig : !it.text.trim());
  if (drop) {
    const idx = items.indexOf(it);
    if (idx >= 0) items.splice(idx, 1);
    if (ed.sel === it) ed.sel = null;
    drawOverlay();
  } else if (isNew || it.text !== orig) {
    selectItem(it);
    markEdited();
  } else drawOverlay();
}

function hitTest(vx, vy) {
  const items = edPage().items;
  const pad = 4 * ed.dpr;
  for (let k = items.length - 1; k >= 0; k--) {
    const b = itemBounds(items[k]);
    if (vx >= b.x - pad && vx <= b.x + b.w + pad && vy >= b.y - pad && vy <= b.y + b.h + pad) return items[k];
  }
  return null;
}

function eventPoints(e) {
  // Use the canvas's actual on-screen size so this stays right mid-zoom, before the re-render lands
  const c = $('edOverlay');
  const vx = e.offsetX * (c.width / c.clientWidth);
  const vy = e.offsetY * (c.height / c.clientHeight);
  return { vx, vy, pdf: ed.vp.convertToPdfPoint(vx, vy) };
}

$('edOverlay').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || ed.space || !ed.vp) return;
  finishInlineEdit();
  const { vx, vy, pdf } = eventPoints(e);
  const hit = hitTest(vx, vy);
  if (ed.tool === 'edit' || (ed.tool === 'text' && isTextItem(hit))) {
    // preventDefault keeps the browser from stealing focus back from the inline box
    e.preventDefault();
    if (isTextItem(hit)) return startInlineEdit(hit);
    if (ed.tool === 'edit') {
      const line = lineAt(pdf[0], pdf[1]);
      if (!line) {
        selectItem(null);
        setStatus(ed.lines.length ? 'No text there – click on a line of text' : 'No editable text found on this page (it may be a scanned image)');
        return;
      }
      const it = makeEditItem(line);
      edPage().items.push(it);
      ed.hover = null;
      return startInlineEdit(it, true);
    }
  }
  if (ed.tool === 'text') {
    e.preventDefault();
    const size = Math.max(4, Math.min(200, +$('edSize').value || 14));
    const it = { type: 'text', text: '', size, color: $('edColor').value, x: pdf[0], y: pdf[1] + size * 0.35, rot: ed.rotation, ...ed.style };
    edPage().items.push(it);
    return startInlineEdit(it, true);
  }
  $('edOverlay').setPointerCapture(e.pointerId);
  if (ed.tool === 'box') {
    ed.drag = { kind: 'newbox', start: pdf, cur: pdf };
    selectItem(null);
    return;
  }
  if (hit) {
    selectItem(hit);
    ed.drag = { kind: 'move', item: hit, start: pdf, orig: { ...hit } };
    $('edOverlay').classList.add('moving');
    return;
  }
  selectItem(null);
});

// Clicking the canvas must not move keyboard focus, or it would close the inline text box
$('edOverlay').addEventListener('mousedown', (e) => e.preventDefault());

$('edOverlay').addEventListener('dblclick', (e) => {
  if (!ed.vp || ed.tool !== 'select') return;
  const { vx, vy } = eventPoints(e);
  const hit = hitTest(vx, vy);
  if (isTextItem(hit)) startInlineEdit(hit);
});

$('edOverlay').addEventListener('pointerleave', () => {
  if (ed.hover) {
    ed.hover = null;
    drawOverlay();
  }
});

$('edOverlay').addEventListener('pointermove', (e) => {
  if (!ed.vp) return;
  if (!ed.drag) {
    if (ed.tool !== 'edit' || ed.inline) return;
    const { vx, vy, pdf } = eventPoints(e);
    const line = hitTest(vx, vy) ? null : lineAt(pdf[0], pdf[1]);
    if (line !== ed.hover) {
      ed.hover = line;
      drawOverlay();
    }
    return;
  }
  const { pdf } = eventPoints(e);
  const d = ed.drag;
  if (d.kind === 'newbox') {
    d.cur = pdf;
    drawOverlay();
  } else if (d.kind === 'move') {
    const dx = pdf[0] - d.start[0];
    const dy = pdf[1] - d.start[1];
    if (d.item.type === 'box') {
      Object.assign(d.item, { x1: d.orig.x1 + dx, y1: d.orig.y1 + dy, x2: d.orig.x2 + dx, y2: d.orig.y2 + dy });
    } else {
      Object.assign(d.item, { x: d.orig.x + dx, y: d.orig.y + dy });
    }
    d.moved = true;
    drawOverlay();
  }
});

$('edOverlay').addEventListener('pointerup', () => {
  const d = ed.drag;
  ed.drag = null;
  $('edOverlay').classList.remove('moving');
  if (!d) return;
  if (d.kind === 'newbox') {
    const [x1, y1] = d.start;
    const [x2, y2] = d.cur;
    if (Math.abs(x2 - x1) > 2 && Math.abs(y2 - y1) > 2) {
      const it = { type: 'box', x1, y1, x2, y2 };
      edPage().items.push(it);
      ed.sel = it;
      markEdited();
    } else drawOverlay();
  } else if (d.kind === 'move' && d.moved) markEdited();
});

function editSelected(fn) {
  if (isTextItem(ed.sel)) {
    fn(ed.sel);
    markEdited();
  }
}

function setStyle(patch) {
  Object.assign(ed.style, patch);
  syncStyleControls();
  editSelected((it) => Object.assign(it, patch));
}

$('edFont').addEventListener('change', () => setStyle({ font: $('edFont').value }));
$('edBold').addEventListener('click', () => setStyle({ bold: !ed.style.bold }));
$('edItalic').addEventListener('click', () => setStyle({ italic: !ed.style.italic }));
$('edText').addEventListener('input', () => editSelected((it) => (it.text = $('edText').value)));
$('edSize').addEventListener('input', () => {
  const v = +$('edSize').value;
  if (v >= 4 && v <= 200) editSelected((it) => (it.size = v));
});
$('edColor').addEventListener('input', () => editSelected((it) => (it.color = $('edColor').value)));
$('edText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    $('edText').blur();
  }
});

function deleteEditorItem() {
  if (!ed.sel) return;
  const items = edPage().items;
  items.splice(items.indexOf(ed.sel), 1);
  ed.sel = null;
  markEdited();
}

function editorGo(delta) {
  const n = ed.i + delta;
  if (n < 0 || n >= pages.length) return;
  finishInlineEdit();
  ed.i = n;
  ed.sel = null;
  loadEditorPage();
}

document.querySelectorAll('#toolSeg button').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('edDelete').addEventListener('click', deleteEditorItem);
$('edPrev').addEventListener('click', () => editorGo(-1));
$('edNext').addEventListener('click', () => editorGo(1));
$('edDone').addEventListener('click', closeEditor);

let resizeTimer = null;
window.addEventListener('resize', () => {
  if ($('editor').classList.contains('hidden')) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(loadEditorPage, 150);
});

// ---------- Toolbar & keyboard ----------

async function pickFiles() {
  addFiles(await window.api.openFiles());
}

$('btnAdd').addEventListener('click', pickFiles);
$('btnAdd2').addEventListener('click', pickFiles);
$('btnRotL').addEventListener('click', () => rotatePages(targetUids(), -90));
$('btnRotR').addEventListener('click', () => rotatePages(targetUids(), 90));
$('btnEdit').addEventListener('click', () => openEditor());
$('btnDup').addEventListener('click', () => duplicatePages(targetUids()));
$('btnDel').addEventListener('click', () => deletePages(targetUids()));
$('btnUndo').addEventListener('click', undo);
$('btnClear').addEventListener('click', clearAll);
$('btnSave').addEventListener('click', () => saveList(pages, defaultName()));
$('btnExtract').addEventListener('click', () => saveList(selectedPages(), defaultName('-selected')));
$('btnSplit').addEventListener('click', splitPages);

document.addEventListener('keydown', (e) => {
  if (!$('busy').classList.contains('hidden')) return;
  const inInput = e.target.matches('input, textarea');
  const ctrl = e.ctrlKey || e.metaKey;
  const editorOpen = !$('editor').classList.contains('hidden');

  if (editorOpen) {
    if (inInput) return;
    if (ctrl && (e.key === '=' || e.key === '+')) setZoom(ed.zoom * 1.25);
    else if (ctrl && e.key === '-') setZoom(ed.zoom / 1.25);
    else if (ctrl && e.key === '0') $('edZoomFit').click();
    else if (e.key === ' ') {
      ed.space = true;
      $('edStage').classList.add('pan-ready');
    } else if (e.key === 'Escape') closeEditor();
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteEditorItem();
    else if (e.key === 'PageDown') editorGo(1);
    else if (e.key === 'PageUp') editorGo(-1);
    else if (e.key === 'e') setTool('edit');
    else if (e.key === 'v') setTool('select');
    else if (e.key === 't') setTool('text');
    else if (e.key === 'w') setTool('box');
    else return;
    e.preventDefault();
    return;
  }
  if (inInput) return;
  const k = e.key.toLowerCase();
  if (ctrl && k === 'o') pickFiles();
  else if (ctrl && k === 's') pages.length && saveList(pages, defaultName());
  else if (ctrl && k === 'z') undo();
  else if (ctrl && k === 'a') { selected = new Set(pages.map((p) => p.uid)); renderSelection(); }
  else if (ctrl && k === 'd') duplicatePages(targetUids());
  else if (e.key === 'Delete') deletePages(targetUids());
  else if (k === 'r' && !ctrl) rotatePages(targetUids(), e.shiftKey ? -90 : 90);
  else if (e.key === 'Enter') openEditor();
  else if (e.key === 'Escape') { selected.clear(); renderSelection(); }
  else return;
  e.preventDefault();
});

window.api.onOpenPaths((files) => addFiles(files));
renderGrid();
