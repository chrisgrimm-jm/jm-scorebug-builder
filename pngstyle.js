// PNG scorebug styles, entirely in the browser: unzip a designer's pack, auto build from the reference,
// turn the layout into display nodes, and pack/unpack style files. Used by pngedit.html both on the designer
// site (GitHub Pages, exports a style file) and in the app (saves straight in). Self-check: node pngstyle.js
//
// Upload guesses so the setup starts mostly right:
//   'reference' in a file name    -> the full-bug reference (setup underlay + auto build, never on air)
//   a folder named {field}        -> its PNGs are that field's options (team logos...)
//   any other folder of 2+ PNGs   -> options too, field guessed by auto build or named by the designer
//   [field] [!f] [f=x] [f>=n] in a name -> shown only when true, same as PSD layers
//   a numeric prefix ("01 bg.png") sets the stacking order, else bigger pieces go underneath
const PNGStyle = (() => {
  const TEXT = /\{(\w+)\}/g, COND = /\[(!?)(\w+)\s*(>=|<=|!=|=|>|<)?\s*([^\]]*?)\s*\]/;
  const MATCH = 40;  // max channel difference for a pixel to count as "same as the reference"
  const words = s => s.replace(/\[.*?\]|\{.*?\}/g, ' ').split(/\s+/).filter(Boolean);
  const prefix = s => { const m = s.match(/^\s*(\d+)/); return m ? +m[1] : 1e6; };
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  function guessField(name) {  // 'Left teams' -> awayTeam, 'Right teams' -> homeTeam, else camelCase
    const w = words(name.toLowerCase());
    if (w.includes('team') || w.includes('teams')) {
      if (w.some(x => ['left', 'top', 'away'].includes(x))) return 'awayTeam';
      if (w.some(x => ['right', 'bottom', 'home'].includes(x))) return 'homeTeam';
    }
    const c = w.map(x => x.replace(/\W/g, '')).filter(Boolean);
    return c.length ? c[0] + c.slice(1).map(x => x[0].toUpperCase() + x.slice(1)).join('') : 'field';
  }

  // Same field typing as the PSD importer (import_psd.py cond_of/finish_fields), so styles from either feed the same.
  function condOf(f, op, v, fields) {
    const fd = (fields[f] ||= {});
    if (['>=', '<=', '>', '<'].includes(op)) fd.type = 'number';
    else if (op === '=' || op === '!=') (fd.options ||= []).push(v);
    else fd.bool = true;
    return { f, op, v };
  }
  function finishFields(fields) {
    for (const fd of Object.values(fields)) {
      if (fd.options) { fd.options = [...new Set(fd.options)]; fd.type ??= 'choice'; }
      fd.type ??= fd.bool && !fd.text ? 'bool' : 'text';
      delete fd.bool; delete fd.text;
    }
    return fields;
  }

  // Layout items (bottom first) -> display nodes + fields. Pieces sharing a picker field become one group.
  function build(edit) {
    const fields = {}, nodes = [], pickers = {};
    for (const it of edit.items) {
      const f = (it.field || '').trim();
      if (it.k === 'text') {
        const node = { t: 'text', tpl: it.tpl, x: it.x, y: it.y, size: it.size, font: it.font, color: it.color,
          anchor: it.anchor, track: 0, caps: !!it.caps, name: it.tpl };
        if (it.maxw) node.maxw = it.maxw;
        for (const [, tf] of it.tpl.matchAll(TEXT)) {
          const fd = (fields[tf] ||= {});
          fd.text = true;
          if (/^-?\d+$/.test(String(edit.sample?.[tf] ?? ''))) { fd.type ??= 'number'; fd.default ??= '0'; }  // test value 4 -> +/- buttons
        }
        nodes.push(node);
        continue;
      }
      if (it.role === 'off') continue;  // in the pack but not used
      const node = { t: 'img', src: it.src, x: it.x, y: it.y, w: it.w, h: it.h, name: it.name };
      if (it.role === 'pick' && f) {
        if (!pickers[f]) nodes.push(pickers[f] = { t: 'g', pick: f, name: `{${f}}`, children: [] });
        node.opt = String(it.value || it.name).trim();
        if (node.opt !== '*') ((fields[f] ||= {}).options ||= []).push(node.opt);  // "*" = shown when nothing else matches
        pickers[f].children.push(node);
        continue;
      }
      if (it.role === 'if' && f) node.if = condOf(f, it.op || 'truthy', ['truthy', '!'].includes(it.op || 'truthy') ? '' : String(it.value ?? ''), fields);
      nodes.push(node);
    }
    const fonts = [...new Set(edit.items.filter(i => i.k === 'text').map(i => i.font))].sort();
    return { width: edit.width, height: edit.height, fonts, fields: finishFields(fields), nodes };
  }

  // ---- browser only below: canvas pixels ----
  const load = src => new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => bad(new Error('Could not read image ' + src.slice(0, 60))); im.src = src; });
  function pixels(img, w, h, dx = 0, dy = 0) {
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, dx, dy);
    return ctx.getImageData(0, 0, w, h).data;
  }

  // Zip of full-frame PNGs -> { edit, images: {src: dataURL} }. Needs JSZip on the page.
  async function unpackZip(file) {
    const zip = await JSZip.loadAsync(file).catch(() => { throw new Error('That is not a .zip of PNGs'); });
    let files = Object.values(zip.files).filter(f => !f.dir && /\.png$/i.test(f.name) && !f.name.includes('__MACOSX') &&
      !f.name.split('/').pop().startsWith('.'));
    if (!files.length) throw new Error('No PNGs in that zip');
    if (files.length > 400) throw new Error(`${files.length} PNGs: more than 400 looks like the wrong zip`);
    const parts = files.map(f => f.name.split('/'));
    const strip = new Set(parts.map(p => p[0])).size === 1 && parts.every(p => p.length > 1) ? 1 : 0;  // zip of a folder
    let size, ref = null, n = 0;
    const items = [], images = {};
    for (const [i, f] of files.entries()) {
      const img = await load(URL.createObjectURL(await f.async('blob')));
      size ||= [img.naturalWidth, img.naturalHeight];
      const W = img.naturalWidth, H = img.naturalHeight, px = pixels(img, W, H);
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (x1 < 0) continue;  // fully transparent
      const src = `img_${++n}.png`, w = x1 - x0 + 1, h = y1 - y0 + 1;
      const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
      c.getContext('2d').drawImage(img, -x0, -y0);
      images[src] = c.toDataURL('image/png');
      const p = parts[i], stem = p[p.length - 1].replace(/\.png$/i, '');
      const piece = { k: 'img', src, x: x0, y: y0, w, h, name: stem, folder: p.slice(strip, -1).join('/'),
        role: 'always', field: '', op: 'truthy', value: '' };
      if (/reference/i.test(stem) && !ref) { ref = piece; continue; }
      const m = stem.match(COND);
      if (m) Object.assign(piece, { role: 'if', field: m[2], op: m[3] || (m[1] ? '!' : 'truthy'), value: m[4] });
      items.push(piece);
    }
    const byFolder = new Map();
    for (const it of items) byFolder.has(it.folder) ? byFolder.get(it.folder).push(it) : byFolder.set(it.folder, [it]);
    for (const [folder, kids] of byFolder) {
      const pick = (folder.split('/').pop() || '').match(/^\{(\w+)\}$/);
      if (!folder || (kids.length < 2 && !pick)) continue;
      const sets = kids.map(k => new Set(words(k.name).map(w => w.toLowerCase())));
      const common = kids.length > 1 ? [...sets[0]].filter(w => sets.every(s => s.has(w))) : [];
      for (const k of kids) if (k.role === 'always')  // "knasty left" in "Left teams" -> option "knasty"
        Object.assign(k, { role: 'pick', field: pick ? pick[1] : '',
          value: words(k.name).filter(w => !common.includes(w.toLowerCase())).join(' ') || k.name });
    }
    const key = it => [prefix(it.name), -it.w * it.h];
    const cmp = (a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1];
    const groups = [...byFolder.values()].map(k => k.sort(cmp)).sort((a, b) => cmp(a[0], b[0]));  // folder stays together
    const [width, height] = size || [1920, 1080];
    return { edit: { items: groups.flat(), ref, sample: {}, width, height }, images };
  }

  // Work the setup out from the reference: which option each folder shows, what's hidden, what sits on top of what,
  // and live text wherever the reference has something no piece explains. images: {src: url or dataURL}.
  async function autobuild(edit, images, defaultFont = 'BebasNeue-Regular') {
    const ref = edit.ref;
    if (!ref) return edit;
    edit = structuredClone(edit);
    const { x: X0, y: Y0, w: W, h: H } = ref, N = W * H;
    const R = pixels(await load(images[ref.src]), W, H);
    const imgs = edit.items.filter(i => i.k === 'img'), L = new Map(), op = new Map(), loaded = new Map();
    for (const it of imgs) {
      loaded.set(it, await load(images[it.src]));
      const p = pixels(loaded.get(it), W, H, it.x - X0, it.y - Y0);
      L.set(it, p);
      const o = new Uint8Array(N);
      for (let i = 0; i < N; i++) o[i] = p[i * 4 + 3] > 128;
      op.set(it, o);
    }
    const same = (p, i) => Math.max(Math.abs(p[i * 4] - R[i * 4]), Math.abs(p[i * 4 + 1] - R[i * 4 + 1]), Math.abs(p[i * 4 + 2] - R[i * 4 + 2])) < MATCH;
    const score = (it, region = op.get(it)) => {  // share of the piece's pixels that look exactly like the reference
      let n = 0, s = 0;
      for (let i = 0; i < N; i++) if (region[i]) { n++; s += same(L.get(it), i); }
      return n ? s / n : 0;
    };
    const shown = [], sample = { ...(edit.sample || {}) }, folders = new Map();
    for (const it of imgs) {
      const k = it.folder + '|' + (it.role === 'pick');
      folders.has(k) ? folders.get(k).push(it) : folders.set(k, [it]);
    }
    for (const kids of folders.values()) {
      if (kids[0].role === 'pick') {
        for (const k of kids) k.field ||= guessField(k.folder);
        const best = kids.reduce((a, b) => score(b) > score(a) ? b : a);
        shown.push(best);
        sample[best.field] = best.value;
        continue;
      }
      for (const it of kids) {
        if (it.role === 'off') continue;
        if (score(it) >= 0.15) shown.push(it);  // backgrounds are mostly covered: any real share of matching pixels = it's there
        else if (it.role === 'always') {  // in the pack but not in the reference: shown only sometimes
          Object.assign(it, { role: 'if', field: guessField(it.name), op: 'truthy', value: '' });
          sample[it.field] = false;
        }
      }
    }
    // "top inning arrow" hidden + "bottom inning arrow" shown = a top/bottom pair
    const byName = new Map(imgs.filter(i => i.role !== 'pick').map(i => [i.name.toLowerCase(), i]));
    for (const [name, it] of byName) {
      const w = name.split(/\s+/), half = w.find(x => x === 'top' || x === 'bottom');
      const twin = byName.get(w.map(x => ({ top: 'bottom', bottom: 'top' })[x] || x).join(' '));
      if (half && twin && shown.includes(it) !== shown.includes(twin)) {
        delete sample[it.field];  // drop the toggle guessed above
        Object.assign(it, { role: 'if', field: 'topOrBottom', op: '=', value: half });
        if (shown.includes(it)) sample.topOrBottom = half;
      }
    }
    // Stacking: where two shown pieces overlap, the one the reference shows is on top.
    const block = it => it.folder || it;
    const above = new Map();
    for (let i = 0; i < shown.length; i++) for (const b of shown.slice(i + 1)) {
      const a = shown[i];
      if (block(a) === block(b)) continue;
      const both = new Uint8Array(N);
      let cnt = 0;
      for (let j = 0; j < N; j++) cnt += both[j] = op.get(a)[j] & op.get(b)[j];
      if (cnt < 20) continue;
      const sa = score(a, both), sb = score(b, both);
      if (Math.abs(sa - sb) > 0.2) {
        const [hi, lo] = sa > sb ? [a, b] : [b, a];
        (above.get(block(hi)) || above.set(block(hi), new Set()).get(block(hi))).add(block(lo));
      }
    }
    const blocks = [...new Set(imgs.map(block))], vis = new Set(shown.map(block)), order = [];
    const place = (bk, seen = []) => {  // everything this block covers goes underneath it first
      if (order.includes(bk) || seen.includes(bk)) return;
      for (const lo of [...(above.get(bk) || [])].sort((x, y) => blocks.indexOf(x) - blocks.indexOf(y))) place(lo, [...seen, bk]);
      order.push(bk);
    };
    [...blocks.filter(b => vis.has(b)), ...blocks.filter(b => !vis.has(b))].forEach(b => place(b));  // hidden extras on top
    const sorted = [...imgs].sort((a, b) => order.indexOf(block(a)) - order.indexOf(block(b)));
    let texts = edit.items.filter(i => i.k === 'text');

    // Live text: whatever in the reference the pieces don't explain.
    if (!texts.length) {
      const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
      const ctx = c.getContext('2d', { willReadFrequently: true });
      for (const it of sorted) if (shown.includes(it)) ctx.drawImage(loaded.get(it), it.x - X0, it.y - Y0);
      const comp = ctx.getImageData(0, 0, W, H).data;
      let miss = new Uint8Array(N);
      for (let i = 0; i < N; i++) miss[i] = R[i * 4 + 3] > 128 && !same(comp, i);
      const morph = (m, keep) => {  // 3x3 cross erode (keep=all) / dilate (keep=any): drops 1px slivers
        const o = new Uint8Array(N);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const v = [m[y * W + x], x > 0 && m[y * W + x - 1], x < W - 1 && m[y * W + x + 1], y > 0 && m[(y - 1) * W + x], y < H - 1 && m[(y + 1) * W + x]];
          o[y * W + x] = keep === 'all' ? v.every(Boolean) : v.some(Boolean);
        }
        return o;
      };
      miss = morph(morph(miss, 'all'), 'any');
      const lab = new Int32Array(N), boxes = [];
      for (let s = 0, id = 0; s < N; s++) if (miss[s] && !lab[s]) {  // 4-connected flood fill
        lab[s] = ++id;
        const st = [s];
        let area = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
        while (st.length) {
          const p = st.pop(), x = p % W, y = (p - x) / W;
          area++; x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1);
          for (const q of [x > 0 && p - 1, x < W - 1 && p + 1, y > 0 && p - W, y < H - 1 && p + W])
            if (q !== false && miss[q] && !lab[q]) { lab[q] = id; st.push(q); }
        }
        if (y1 - y0 >= 8 && area >= 20) boxes.push([x0, y0, x1, y1, id]);
      }
      const groups = [];
      for (const b of boxes.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {  // characters of one value: side by side, sharing most of their height
        const g = groups[groups.length - 1];
        if (g && b[0] - g[2] < 0.6 * Math.max(b[3] - b[1], g[3] - g[1]) &&
            Math.min(b[3], g[3]) - Math.max(b[1], g[1]) > 0.5 * Math.min(b[3] - b[1], g[3] - g[1])) {
          g.splice(0, 4, Math.min(g[0], b[0]), Math.min(g[1], b[1]), Math.max(g[2], b[2]), Math.max(g[3], b[3]));
          g[4].push(b[4]);
        } else groups.push([b[0], b[1], b[2], b[3], [b[4]]]);
      }
      groups.sort((a, b) => Math.floor(a[1] / 30) - Math.floor(b[1] / 30) || a[0] - b[0]);
      texts = groups.map(([x0, y0, x1, y1, ids], i) => {
        const ch = [[], [], []];
        for (let p = 0; p < N; p++) if (ids.includes(lab[p])) for (let k = 0; k < 3; k++) ch[k].push(R[p * 4 + k]);
        const med = a => a.sort((x, y) => x - y)[a.length >> 1];
        sample[`text${i + 1}`] = '0';
        return { k: 'text', tpl: `{text${i + 1}}`, x: X0 + ((x0 + x1) >> 1), y: Y0 + y1,
          size: Math.round((y1 - y0) / 0.7),  // ponytail: cap height ~0.7em (Bebas-like); tweak per font
          font: defaultFont, color: '#' + ch.map(a => med(a).toString(16).padStart(2, '0')).join(''), anchor: 'middle', caps: true, maxw: null };
      });
    }
    return { ...edit, items: [...sorted, ...texts], sample };
  }

  // Style file: one .json with the images inside, for the designer site -> app hand-off.
  const toStyleFile = (sport, title, edit, images) => ({ jmStyle: 1, sport, title, ...build(edit), edit, images });

  return { build, unpackZip, autobuild, toStyleFile, guessField, words, slug };
})();

if (typeof module !== 'undefined' && require.main === module) {  // node pngstyle.js: the parts without pixels
  const assert = require('assert');
  const edit = { width: 100, height: 50, sample: { awayScore: '3' }, items: [
    { k: 'img', src: 'a.png', x: 0, y: 0, w: 9, h: 9, name: 'bg', role: 'always', field: '' },
    { k: 'img', src: 'b.png', x: 0, y: 0, w: 9, h: 9, name: 'knasty left', role: 'pick', field: 'awayTeam', value: 'knasty' },
    { k: 'img', src: 'c.png', x: 0, y: 0, w: 9, h: 9, name: 'arrow', role: 'if', field: 'topOrBottom', op: '=', value: 'top' },
    { k: 'img', src: 'd.png', x: 0, y: 0, w: 9, h: 9, name: 'rippers left', role: 'pick', field: 'awayTeam', value: 'rippers' },
    { k: 'img', src: 'e.png', x: 0, y: 0, w: 9, h: 9, name: 'blank', role: 'pick', field: 'awayTeam', value: '*' },
    { k: 'img', src: 'f.png', x: 0, y: 0, w: 9, h: 9, name: 'spare', role: 'off', field: '' },
    { k: 'text', tpl: '{awayScore}', x: 5, y: 5, size: 40, font: 'F', color: '#fff', anchor: 'middle' },
    { k: 'text', tpl: '/', x: 5, y: 5, size: 40, font: 'F', color: '#fff', anchor: 'middle' },
  ] };
  const { nodes, fields } = PNGStyle.build(edit);
  assert.deepEqual(nodes.map(n => n.pick || n.t), ['img', 'awayTeam', 'img', 'text', 'text']);
  assert.deepEqual(nodes[1].children.map(c => c.opt), ['knasty', 'rippers', '*']);
  assert.deepEqual(nodes[2].if, { f: 'topOrBottom', op: '=', v: 'top' });
  assert.deepEqual(fields.awayTeam, { options: ['knasty', 'rippers'], type: 'choice' });
  assert.deepEqual([fields.awayScore.type, fields.topOrBottom.type], ['number', 'choice']);
  assert.equal(Object.keys(fields).length, 3, 'fixed text adds no field');
  assert.deepEqual([PNGStyle.guessField('Left teams'), PNGStyle.guessField('Right Teams'), PNGStyle.guessField('top inning arrow')],
    ['awayTeam', 'homeTeam', 'topInningArrow']);
  assert.deepEqual(PNGStyle.words('Rippers Right [x]'), ['Rippers', 'Right']);
  console.log('pngstyle.js: all checks passed');
}
