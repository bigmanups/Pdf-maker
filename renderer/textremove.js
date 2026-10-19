'use strict';

// Removes original text that was replaced in the editor from the page's content stream, so the
// old words are really gone from the saved file (not just covered up).
//
// Every text-drawing operator is located in user space; one whose whole run lies inside an edited
// area is swapped for an empty TJ that moves the text cursor by the same distance, so any text
// that follows on the same line stays exactly where it was. Anything that can't be measured
// safely (unusual fonts, text inside form XObjects) is left alone and simply stays covered.
const TextRemover = (() => {
  const { PDFName, PDFArray, PDFDict, PDFNumber, PDFRawStream, decodePDFRawStream } = PDFLib;
  const WS = new Set([0, 9, 10, 12, 13, 32]);
  const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));
  const I = [1, 0, 0, 1, 0, 0];

  const mul = (m, n) => [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const fmt = (v) => (Math.abs(v) < 1e-6 ? '0' : v.toFixed(4).replace(/\.?0+$/, ''));
  const latin = (b, s, e) => String.fromCharCode(...b.subarray(s, e));

  // Content stream tokenizer: yields each operator with its operands and byte span.
  function* operators(b) {
    const n = b.length;
    let i = 0;
    let stack = [];
    const nest = [];
    let opStart = -1;
    const push = (v, s) => {
      if (opStart < 0) opStart = s;
      (nest.length ? nest[nest.length - 1] : stack).push(v);
    };
    while (i < n) {
      const c = b[i];
      if (WS.has(c)) { i++; continue; }
      const s = i;
      if (c === 37) { // % comment
        while (i < n && b[i] !== 10 && b[i] !== 13) i++;
        continue;
      }
      if (c === 40) { // ( literal string )
        const codes = [];
        let depth = 1;
        i++;
        while (i < n && depth > 0) {
          const ch = b[i++];
          if (ch === 92) {
            const e = b[i++];
            if (e === 110) codes.push(10);
            else if (e === 114) codes.push(13);
            else if (e === 116) codes.push(9);
            else if (e === 98) codes.push(8);
            else if (e === 102) codes.push(12);
            else if (e === 13) { if (b[i] === 10) i++; }
            else if (e === 10) { /* line continuation */ }
            else if (e >= 48 && e <= 55) {
              let v = e - 48;
              for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + (b[i++] - 48);
              codes.push(v & 255);
            } else codes.push(e);
          } else if (ch === 40) { depth++; codes.push(ch); }
          else if (ch === 41) { if (--depth) codes.push(ch); }
          else codes.push(ch);
        }
        push({ t: 'str', codes }, s);
        continue;
      }
      if (c === 60 && b[i + 1] === 60) { // << dict
        if (opStart < 0) opStart = s;
        nest.push([]);
        i += 2;
        continue;
      }
      if (c === 62 && b[i + 1] === 62) { // >>
        nest.pop();
        i += 2;
        push({ t: 'dict' }, s);
        continue;
      }
      if (c === 60) { // <hex string>
        i++;
        let hex = '';
        while (i < n && b[i] !== 62) {
          if (!WS.has(b[i])) hex += String.fromCharCode(b[i]);
          i++;
        }
        i++;
        if (hex.length % 2) hex += '0';
        const codes = [];
        for (let k = 0; k < hex.length; k += 2) codes.push(parseInt(hex.substr(k, 2), 16) || 0);
        push({ t: 'str', codes }, s);
        continue;
      }
      if (c === 91) { // [
        if (opStart < 0) opStart = s;
        nest.push([]);
        i++;
        continue;
      }
      if (c === 93) { // ]
        const items = nest.pop() || [];
        i++;
        push({ t: 'arr', items }, s);
        continue;
      }
      if (c === 47) { // /Name
        i++;
        while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
        push({ t: 'name', v: latin(b, s + 1, i) }, s);
        continue;
      }
      while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
      if (i === s) { i++; continue; } // stray delimiter
      const tok = latin(b, s, i);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { push({ t: 'num', v: parseFloat(tok) }, s); continue; }
      if (tok === 'true' || tok === 'false' || tok === 'null' || nest.length) { push({ t: 'kw' }, s); continue; }
      yield { op: tok, args: stack, start: opStart < 0 ? s : opStart, end: i };
      stack = [];
      opStart = -1;
      if (tok === 'ID') { // inline image: skip binary data up to EI
        i++;
        while (i < n && !(b[i] === 69 && b[i + 1] === 73 && WS.has(b[i - 1]) && (i + 2 >= n || WS.has(b[i + 2]) || DELIM.has(b[i + 2])))) i++;
        i = Math.min(n, i + 2);
      }
    }
  }

  // Glyph widths for the fonts we can measure exactly; null means "don't touch".
  function measurer(resources, name) {
    try {
      const fonts = resources.lookup(PDFName.of('Font'), PDFDict);
      const f = fonts.lookup(PDFName.of(name), PDFDict);
      const subtype = String(f.lookup(PDFName.of('Subtype')));
      if (subtype === '/Type0') {
        if (String(f.lookup(PDFName.of('Encoding'))) !== '/Identity-H') return null;
        const desc = f.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
        const dwObj = desc.lookup(PDFName.of('DW'));
        const dw = dwObj instanceof PDFNumber ? dwObj.asNumber() : 1000;
        const map = new Map();
        const W = desc.lookup(PDFName.of('W'));
        if (W instanceof PDFArray) {
          const a = W.asArray().map((_, k) => W.lookup(k));
          for (let k = 0; k < a.length;) {
            const c1 = a[k].asNumber();
            const nx = a[k + 1];
            if (nx instanceof PDFArray) {
              nx.asArray().forEach((_, j) => map.set(c1 + j, nx.lookup(j).asNumber()));
              k += 2;
            } else {
              const c2 = nx.asNumber();
              const w = a[k + 2].asNumber();
              for (let cc = c1; cc <= c2; cc++) map.set(cc, w);
              k += 3;
            }
          }
        }
        return { bytes: 2, width: (code) => (map.has(code) ? map.get(code) : dw) };
      }
      if (subtype === '/Type3') return null;
      const widths = f.lookup(PDFName.of('Widths'));
      if (!(widths instanceof PDFArray)) return null; // standard 14 fonts without a width table
      const first = f.lookup(PDFName.of('FirstChar'), PDFNumber).asNumber();
      const ws = widths.asArray().map((_, k) => widths.lookup(k, PDFNumber).asNumber());
      let missing = 0;
      const fd = f.lookup(PDFName.of('FontDescriptor'));
      if (fd instanceof PDFDict) {
        const mw = fd.lookup(PDFName.of('MissingWidth'));
        if (mw instanceof PDFNumber) missing = mw.asNumber();
      }
      return { bytes: 1, width: (code) => (code >= first && code < first + ws.length ? ws[code - first] : missing) };
    } catch {
      return null;
    }
  }

  // Horizontal advance of a Tj/TJ in unscaled text space.
  function advance(m, gs, pieces) {
    let tx = 0;
    for (const p of pieces) {
      if (typeof p === 'number') {
        tx -= (p / 1000) * gs.Tfs * gs.Th;
        continue;
      }
      for (let k = 0; k + m.bytes - 1 < p.length; k += m.bytes) {
        const code = m.bytes === 2 ? (p[k] << 8) | p[k + 1] : p[k];
        const w = m.width(code);
        tx += ((w / 1000) * gs.Tfs + gs.Tc + (m.bytes === 1 && code === 32 ? gs.Tw : 0)) * gs.Th;
      }
    }
    return tx;
  }

  function inRect(r, p, tol = 0) {
    return p[0] >= r.x1 - tol && p[0] <= r.x2 + tol && p[1] >= r.y1 - tol && p[1] <= r.y2 + tol;
  }

  // rects: [{ x1, y1, x2, y2 }] in PDF user space. Returns how many text runs were removed.
  function removeText(doc, page, rects) {
    rects = rects.map((r) => ({ x1: Math.min(r.x1, r.x2), y1: Math.min(r.y1, r.y2), x2: Math.max(r.x1, r.x2), y2: Math.max(r.y1, r.y2) }));
    if (!rects.length) return 0;
    const node = page.node;
    const contents = node.Contents();
    let streams = [];
    if (contents instanceof PDFArray) streams = contents.asArray().map((_, k) => contents.lookup(k));
    else if (contents) streams = [contents];
    if (!streams.length || !streams.every((s) => s instanceof PDFRawStream)) return 0;

    const parts = streams.map((s) => decodePDFRawStream(s).decode());
    const b = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
    let off = 0;
    for (const p of parts) {
      b.set(p, off);
      b[off + p.length] = 10;
      off += p.length + 1;
    }

    const resources = node.Resources();
    const fontCache = new Map();
    const getMeasurer = (name) => {
      if (!fontCache.has(name)) fontCache.set(name, resources ? measurer(resources, name) : null);
      return fontCache.get(name);
    };
    let gs = { ctm: I, Tc: 0, Tw: 0, Th: 1, TL: 0, Tfs: 0, Trise: 0, font: null };
    const gstack = [];
    let Tm = I;
    let Tlm = I;
    const nextLine = () => {
      Tlm = mul([1, 0, 0, 1, 0, -gs.TL], Tlm);
      Tm = Tlm;
    };
    const num = (a) => (a && a.t === 'num' ? a.v : 0);
    const edits = [];

    for (const o of operators(b)) {
      const A = o.args;
      switch (o.op) {
        case 'q': gstack.push({ ...gs }); break;
        case 'Q': if (gstack.length) gs = gstack.pop(); break;
        case 'cm': gs.ctm = mul(A.slice(0, 6).map(num), gs.ctm); break;
        case 'BT': Tm = Tlm = I; break;
        case 'Tm': Tm = Tlm = A.slice(0, 6).map(num); break;
        case 'Td': Tlm = mul([1, 0, 0, 1, num(A[0]), num(A[1])], Tlm); Tm = Tlm; break;
        case 'TD': gs.TL = -num(A[1]); Tlm = mul([1, 0, 0, 1, num(A[0]), num(A[1])], Tlm); Tm = Tlm; break;
        case 'T*': nextLine(); break;
        case 'TL': gs.TL = num(A[0]); break;
        case 'Tc': gs.Tc = num(A[0]); break;
        case 'Tw': gs.Tw = num(A[0]); break;
        case 'Tz': gs.Th = num(A[0]) / 100; break;
        case 'Ts': gs.Trise = num(A[0]); break;
        case 'Tf': gs.font = A[0] && A[0].t === 'name' ? A[0].v : null; gs.Tfs = num(A[1]); break;
        case 'Tj': case 'TJ': case "'": case '"': {
          let prefix = '';
          if (o.op === '"') {
            gs.Tw = num(A[0]);
            gs.Tc = num(A[1]);
            prefix = `${fmt(gs.Tw)} Tw ${fmt(gs.Tc)} Tc T* `;
            nextLine();
          } else if (o.op === "'") {
            prefix = 'T* ';
            nextLine();
          }
          const last = A[A.length - 1];
          const pieces = o.op === 'TJ'
            ? (last && last.t === 'arr' ? last.items.filter((x) => x.t === 'num' || x.t === 'str').map((x) => (x.t === 'num' ? x.v : x.codes)) : [])
            : (last && last.t === 'str' ? [last.codes] : []);
          const m = gs.font ? getMeasurer(gs.font) : null;
          const tx = Tm && m && gs.Tfs && gs.Th ? advance(m, gs, pieces) : null;
          if (tx == null) {
            Tm = null; // position unknown until the next explicit move
            break;
          }
          const T = mul(Tm, gs.ctm);
          const p0 = apply(T, 0, gs.Trise);
          const p1 = apply(T, tx, gs.Trise);
          if (rects.some((r) => inRect(r, p0) && inRect(r, p1, (r.y2 - r.y1) * 0.3))) {
            edits.push({ start: o.start, end: o.end, text: `${prefix}[${fmt((-tx / (gs.Tfs * gs.Th)) * 1000)}] TJ` });
          }
          Tm = mul([1, 0, 0, 1, tx, 0], Tm);
          break;
        }
      }
    }
    if (!edits.length) return 0;

    const enc = new TextEncoder();
    const chunks = [];
    let pos = 0;
    for (const e of edits) {
      chunks.push(b.subarray(pos, e.start), enc.encode(e.text));
      pos = e.end;
    }
    chunks.push(b.subarray(pos));
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(out)));
    return edits.length;
  }

  return { removeText };
})();
