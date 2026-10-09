import { run, TIMELINE_WORKERS, TIMELINE_SPANS } from './runner.js';

const presets = [
  { file: '1-hello.js', title: 'Hello, threads' },
  { file: '2-mandelbrot.js', title: 'Mandelbrot (shared array)' },
  { file: '3-nbody.js', title: 'N-body (shared objects, barrier)' },
  { file: '4-words.js', title: 'Word count (strings, Maps)' }
];

const $ = id => document.getElementById(id);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
$('run-key').textContent = isMac ? '⌘↵' : 'Ctrl+↵';
$('output').dataset.key = isMac ? '⌘↵' : 'Ctrl+Enter';

const storage = {
  get: key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
};

// --- status chips ---
const status = $('status');
const chip = (text, kind = '') => {
  const el = document.createElement('span');
  el.className = `chip ${kind}`;
  el.textContent = text;
  status.append(el);
  return el;
};
const ms = t => t >= 1000 ? `${(t / 1000).toFixed(1)} s` : `${Math.round(t)} ms`;

// --- editor: CodeMirror, or a plain textarea if it cannot load ---
let editor;
const setupEditor = async (doc, onChange) => {
  const parent = $('editor');
  try {
    const [ { EditorView, basicSetup }, { javascript }, { oneDark } ] = await Promise.all([
      import('https://esm.sh/codemirror@6.0.2'),
      import('https://esm.sh/@codemirror/lang-javascript@6.2.5'),
      import('https://esm.sh/@codemirror/theme-one-dark@6.1.3')
    ]);
    const view = new EditorView({
      doc, parent,
      extensions: [ basicSetup, javascript(), oneDark, EditorView.updateListener.of(u => u.docChanged && onChange()) ]
    });
    editor = {
      get: () => view.state.doc.toString(),
      set: text => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 }, scrollIntoView: true })
    };
  } catch {
    const ta = document.createElement('textarea');
    ta.spellcheck = false;
    ta.value = doc;
    ta.addEventListener('input', onChange);
    parent.append(ta);
    editor = { get: () => ta.value, set: text => { ta.value = text; } };
  }
};

// --- output: a stream of text with terminal color escapes ---
const output = $('output');
const MAX_OUTPUT = 2_000_000;
const base16 = [ '#3b3645', '#ff6b7f', '#5fd39a', '#f0c060', '#6cb6ff', '#c693f5', '#4fd1d9', '#d8d2e2',
  '#7d7590', '#ff93a1', '#86e8b6', '#ffd98a', '#9ccaff', '#dcbdfb', '#7fe5ec', '#ffffff' ];
const xterm = n => {
  if (n < 16) return base16[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  n -= 16;
  const c = v => v ? 55 + v * 40 : 0;
  return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`;
};

class Ansi {
  constructor() { this.reset(); this.rest = ''; }
  reset() { this.fg = null; this.bg = null; this.bold = false; this.dim = false; this.italic = false; this.underline = false; }
  sgr(params) {
    const p = params.length ? params.split(';').map(Number) : [ 0 ];
    for (let i = 0; i < p.length; i++) {
      const n = p[i];
      if (n === 0) this.reset();
      else if (n === 1) this.bold = true;
      else if (n === 2) this.dim = true;
      else if (n === 3) this.italic = true;
      else if (n === 4) this.underline = true;
      else if (n === 22) this.bold = this.dim = false;
      else if (n === 23) this.italic = false;
      else if (n === 24) this.underline = false;
      else if (n >= 30 && n <= 37) this.fg = base16[n - 30];
      else if (n >= 90 && n <= 97) this.fg = base16[n - 82];
      else if (n >= 40 && n <= 47) this.bg = base16[n - 40];
      else if (n >= 100 && n <= 107) this.bg = base16[n - 92];
      else if (n === 39) this.fg = null;
      else if (n === 49) this.bg = null;
      else if (n === 38 || n === 48) {
        let color = null;
        if (p[i + 1] === 5) { color = xterm(p[i + 2]); i += 2; }
        else if (p[i + 1] === 2) { color = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`; i += 4; }
        if (n === 38) this.fg = color; else this.bg = color;
      }
    }
  }
  // appends text to a fragment, as spans for the styled runs
  write(text, into, cls) {
    text = this.rest + text;
    this.rest = '';
    const re = /\x1b\[([0-9;]*)([A-Za-z])/g;
    let at = 0, m;
    const emit = s => {
      if (!s) return;
      if (!this.fg && !this.bg && !this.bold && !this.dim && !this.italic && !this.underline && !cls) { into.append(s); return; }
      const span = document.createElement('span');
      if (cls || this.bg) span.className = `${cls} ${this.bg ? 'bg' : ''}`.trim();
      if (this.fg) span.style.color = this.fg;
      if (this.bg) span.style.background = this.bg;
      if (this.bold) span.style.fontWeight = '700';
      if (this.dim) span.style.opacity = '0.65';
      if (this.italic) span.style.fontStyle = 'italic';
      if (this.underline) span.style.textDecoration = 'underline';
      span.textContent = s;
      into.append(span);
    };
    while ((m = re.exec(text))) {
      emit(text.slice(at, m.index));
      if (m[2] === 'm') this.sgr(m[1]);
      at = re.lastIndex;
    }
    let tail = text.slice(at);
    // an escape cut off at the end of this chunk: finish it with the next one
    const cut = tail.lastIndexOf('\x1b');
    if (cut !== -1 && /^\x1b(\[[0-9;]*)?$/.test(tail.slice(cut))) { this.rest = tail.slice(cut); tail = tail.slice(0, cut); }
    emit(tail);
  }
}

let ansi = [ new Ansi(), new Ansi(), new Ansi() ];
let queued = [], outputSize = 0, truncated = false, flushing = false, lineBuffer = '';
const write = (fd, text) => {
  queued.push([ fd, text ]);
  if (!flushing) { flushing = true; requestAnimationFrame(flush); }
};
const note = (text, cls = 'note') => {
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text;
  queued.push([ 0, span ]);
  if (!flushing) { flushing = true; requestAnimationFrame(flush); }
};
const flush = () => {
  flushing = false;
  const stick = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
  const frag = document.createDocumentFragment();
  for (const [ fd, text ] of queued) {
    if (typeof text !== 'string') { frag.append(text); continue; }
    if (fd === 1) scanResults(text);
    if (truncated) continue;
    outputSize += text.length;
    if (outputSize > MAX_OUTPUT) {
      truncated = true;
      const span = document.createElement('span');
      span.className = 'note';
      span.textContent = '\n[output truncated]\n';
      frag.append(span);
      continue;
    }
    ansi[fd].write(text, frag, fd === 2 ? 'stderr' : '');
  }
  queued = [];
  output.append(frag);
  if (stick) output.scrollTop = output.scrollHeight;
};
const clearOutput = () => {
  output.textContent = '';
  ansi = [ new Ansi(), new Ansi(), new Ansi() ];
  queued = []; outputSize = 0; truncated = false; lineBuffer = '';
};

// --- the chart: lines like "threads 4  123 ms" ---
let results = [];
const scanResults = text => {
  lineBuffer += text;
  const lines = lineBuffer.split('\n');
  lineBuffer = lines.pop();
  let changed = false;
  for (const line of lines) {
    const m = /^threads\s+(\d+)\s+(\d+(?:\.\d+)?)\s*ms/.exec(line.replace(/\x1b\[[0-9;]*m/g, '').trim());
    if (m) { results.push({ threads: +m[1], ms: +m[2] }); changed = true; }
  }
  if (changed) drawChart();
};
const drawChart = () => {
  const chart = $('chart');
  $('chart-box').hidden = results.length === 0;
  $('viz').hidden = false;
  chart.textContent = '';
  const base = results.find(r => r.threads === 1)?.ms ?? results[0].ms;
  const baseThreads = results.find(r => r.threads === 1) ? 1 : results[0].threads;
  const max = Math.max(...results.map(r => r.ms));
  for (const r of results) {
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = `${r.threads} thread${r.threads === 1 ? '' : 's'}`;
    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = `${(r.ms / max) * 100}%`;
    const ideal = document.createElement('div');
    ideal.className = 'ideal';
    ideal.style.left = `calc(${(base * baseThreads / r.threads / max) * 100}% - 1px)`;
    track.append(fill, ideal);
    const value = document.createElement('div');
    value.className = 'value';
    const speedup = document.createElement('b');
    speedup.textContent = `${(base / r.ms).toFixed(2)}×`;
    value.append(`${ms(r.ms)}  `, speedup);
    chart.append(label, track, value);
  }
};

// --- the thread lanes: when each worker ran a thread, from the times the workers record ---
const lanes = $('lanes');
let laneStart = 0, laneEnd = 0, laneTimer = 0, laneHandle = null;
const GUTTER = 34;
const drawLanes = () => {
  const handle = laneHandle;
  if (!handle) return;
  const n = Math.min(handle.workers(), TIMELINE_WORKERS);
  // 8px lanes, thinner when there are many workers, so all of them fit in ~130px
  const row = Math.max(3, Math.min(11, Math.floor(132 / n))), LANE_GAP = row >= 8 ? 3 : 1, LANE_H = row - LANE_GAP;
  const dpr = devicePixelRatio || 1;
  const w = lanes.clientWidth, h = n * row - LANE_GAP;
  lanes.style.height = `${h}px`;
  if (lanes.width !== Math.round(w * dpr) || lanes.height !== Math.round(h * dpr)) { lanes.width = Math.round(w * dpr); lanes.height = Math.round(h * dpr); }
  const ctx = lanes.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  // worker times are ms since the epoch; the page's are ms since it loaded
  const end = laneEnd || performance.now(), origin = performance.timeOrigin;
  const x = t => GUTTER + Math.max(0, Math.min(1, (t - origin - laneStart) / Math.max(1, end - laneStart))) * (w - GUTTER);
  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const y = i * row;
    ctx.fillStyle = css.getPropertyValue('--muted');
    if (row >= 8 || i === 0 || i % 8 === 0) ctx.fillText(i === 0 ? 'main' : String(i), 0, y + LANE_H / 2 + 0.5);
    ctx.fillStyle = css.getPropertyValue('--lane');
    ctx.fillRect(GUTTER, y, w - GUTTER, LANE_H);
    ctx.fillStyle = css.getPropertyValue('--lane-on');
    const count = Math.min(Atomics.load(handle.spans, i), TIMELINE_SPANS);
    for (let k = 0; k < count; k++) {
      const at = (i * TIMELINE_SPANS + k) * 2;
      const t0 = handle.timeline[at], t1 = handle.timeline[at + 1] || end + origin;
      if (t0) ctx.fillRect(x(t0), y, Math.max(1, x(t1) - x(t0)), LANE_H);
    }
  }
};
addEventListener('resize', () => drawLanes());
const animateLanes = session => {
  drawLanes();
  if (!session.ended) laneTimer = requestAnimationFrame(() => animateLanes(session));
};

// --- compiling, in a worker ---
let compiler, compileId = 0;
const pending = new Map();
const compile = (code, stages, onEvent) => {
  compiler ??= (() => {
    const w = new Worker(new URL('compiler.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      if (data.type === 'done') { pending.delete(data.id); p.resolve(data); }
      else if (data.type === 'error') { pending.delete(data.id); p.reject(new Error(data.message)); }
      else p.onEvent?.(data);
    };
    w.onerror = e => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'the compiler worker failed to load'));
      pending.clear();
      compiler = null;
    };
    return w;
  })();
  const id = ++compileId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onEvent });
    compiler.postMessage({ id, code, stages });
  });
};

const sha256 = async text => [ ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))) ].map(b => b.toString(16).padStart(2, '0')).join('');

// presets built ahead of time (build.js), by the hash of their source
let prebuilt;
const prebuiltWasm = async hash => {
  prebuilt ??= fetch('build/presets/manifest.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
  const name = Object.entries(await prebuilt).find(([ , h ]) => h === hash)?.[0];
  if (!name) return null;
  const r = await fetch(`build/presets/${name}.wasm`);
  return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
};

const wasmCache = new Map(), cCache = new Map();

// --- running ---
let current = null;
const runButton = $('run'), stopButton = $('stop');

const setRunning = on => {
  runButton.disabled = on;
  stopButton.hidden = !on;
};

const runCode = async () => {
  if (current && !current.ended) return;
  showTab('output');
  const code = editor.get();
  const session = current = { ended: false };
  status.textContent = '';
  clearOutput();
  results = [];
  laneHandle = null;
  $('chart').textContent = '';
  $('chart-box').hidden = true;
  $('viz').hidden = true;
  setRunning(true);

  const end = (text, kind) => {
    session.ended = true;
    setRunning(false);
    for (const el of status.querySelectorAll('.busy')) el.remove();
    if (text) chip(text, kind);
  };

  try {
    if (!self.crossOriginIsolated) throw new Error('this page is not cross-origin isolated, so it cannot share memory between threads (see the note below)');
    const hash = await sha256(code);
    let wasm = wasmCache.get(hash);
    if (!wasm && (wasm = await prebuiltWasm(hash))) chip('precompiled', 'ok');
    if (!wasm) {
      let c = chip('JS → C…', 'busy'), w;
      const result = await compile(code, [ 'wasm' ], e => {
        if (e.type === 'stage' && e.stage === 'c') {
          c.className = 'chip'; c.textContent = `JS → C ${ms(e.ms)}`;
          w = chip('C → Wasm…', 'busy');
        } else if (e.type === 'download') {
          w.textContent = e.done < e.total ? `downloading clang ${Math.round(e.done / e.total * 100)}%` : 'starting clang…';
        } else if (e.type === 'stage' && e.stage === 'wasm') {
          w.className = 'chip'; w.textContent = `C → Wasm ${ms(e.ms)}`;
        }
      });
      wasm = result.wasm;
      wasmCache.set(hash, wasm);
    }
    if (session !== current || session.ended) return;

    const r = chip('starting…', 'busy');
    let t0;
    const handle = await run(wasm, {
      out: (fd, text) => write(fd, text),
      exit: code => {
        const t = performance.now() - t0;
        r.remove();
        laneEnd = performance.now();
        end(code === 0 ? `finished in ${ms(t)}` : `exit code ${code} after ${ms(t)}`, code === 0 ? 'ok' : 'err');
        drawLanes();
      },
      crash: message => {
        r.remove();
        laneEnd = performance.now();
        end('crashed', 'err');
        note(`\n${message}\n`, 'stderr');
        drawLanes();
      }
    });
    session.handle = laneHandle = handle;
    t0 = laneStart = performance.now();
    laneEnd = 0;
    if (!session.ended) {
      r.textContent = 'running';
      $('viz').hidden = false;
      $('lanes-note').textContent = 'one row per worker: lit while it runs a thread';
      animateLanes(session);
    }
  } catch (e) {
    end(e instanceof WebAssembly.CompileError ? 'unsupported browser' : 'error', 'err');
    const extra = e instanceof WebAssembly.CompileError ? '\nThis browser cannot load the program: it needs WebAssembly threads and exception handling (exnref), as in recent Chrome, Firefox and Safari.' : '';
    note(`${e.message}${extra}\n`, 'stderr');
  }
};

const stop = () => {
  if (!current || current.ended) return;
  current.handle?.stop();
  current.ended = true;
  cancelAnimationFrame(laneTimer);
  laneEnd = performance.now();
  drawLanes();
  for (const el of status.querySelectorAll('.busy')) el.remove();
  chip('stopped', 'err');
  setRunning(false);
  // a compile in flight finishes in the background; its result is cached
};

runButton.addEventListener('click', runCode);
stopButton.addEventListener('click', stop);
addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); runCode(); }
  if (e.key === 'Escape') stop();
}, true);

// --- the C tab ---
const showTab = which => {
  $('tab-output').setAttribute('aria-selected', String(which === 'output'));
  $('tab-c').setAttribute('aria-selected', String(which === 'c'));
  output.hidden = which !== 'output';
  $('viz').hidden = which !== 'output' || !laneHandle;
  $('csource').hidden = which !== 'c';
  if (which === 'c') showC();
};
const showC = async () => {
  const code = editor.get(), pre = $('csource');
  const hash = await sha256(code);
  if (pre.dataset.hash === hash) return;
  pre.dataset.hash = hash;
  pre.textContent = 'compiling…';
  try {
    let c = cCache.get(hash);
    if (!c) cCache.set(hash, c = (await compile(code, [ 'c' ])).c);
    if (pre.dataset.hash !== hash) return;
    // start at the first function compiled from your code, after the runtime and builtins
    const lines = c.split('\n'), first = lines.findIndex(l => /^\w+ p__main_\w*\(.*\) \{$/.test(l));
    pre.textContent = `// ${lines.length} lines of C, generated by Porffor from your JS${first >= 0 ? `: your code starts at line ${first + 2}` : ''}\n${c}`;
    if (first > 0) pre.scrollTop = (first + 1) * parseFloat(getComputedStyle(pre).lineHeight);
  } catch (e) {
    if (pre.dataset.hash === hash) pre.textContent = e.message;
  }
};
$('tab-output').addEventListener('click', () => showTab('output'));
$('tab-c').addEventListener('click', () => showTab('c'));

// --- presets, sharing and remembering the code ---
const select = $('preset');
for (const p of presets) select.append(new Option(p.title, p.file));
const custom = new Option('Your code', '');
const loadPreset = async file => (await fetch(`presets/${file}`)).text();

const toBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const pack = async text => toBase64Url(new Uint8Array(await new Response(new Blob([ text ]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()));
const unpack = async s => new Response(new Blob([ fromBase64Url(s) ]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();

$('share').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#code=${await pack(editor.get())}`;
  history.replaceState(null, '', url);
  try { await navigator.clipboard.writeText(url); flash('link copied'); } catch { flash('link in the address bar'); }
});
const flash = text => {
  const c = chip(text, 'ok');
  setTimeout(() => c.remove(), 2000);
};

const remember = () => {
  storage.set('porffor-threads-playground', { preset: select.value, code: editor.get() });
};
select.addEventListener('change', async () => {
  if (!select.value) return;
  custom.remove();
  editor.set(await loadPreset(select.value));
  history.replaceState(null, '', location.pathname);
  storage.set('porffor-threads-playground', { preset: select.value, code: null });
});

let initial, initialPreset = presets[1].file;
if (location.hash.startsWith('#code=')) {
  try { initial = await unpack(location.hash.slice(6)); initialPreset = ''; } catch {}
}
if (initial == null) {
  const saved = storage.get('porffor-threads-playground');
  const isPreset = presets.some(p => p.file === saved?.preset);
  if (saved?.code != null) { initial = saved.code; initialPreset = isPreset ? saved.preset : ''; }
  else initial = await loadPreset(initialPreset = isPreset ? saved.preset : initialPreset);
}
if (!initialPreset) { select.prepend(custom); select.value = ''; }
else select.value = initialPreset;
await setupEditor(initial, remember);

const cores = navigator.hardwareConcurrency;
$('env').innerHTML = (cores ? `${cores} cores` : '') + (self.crossOriginIsolated ? '' :
  ' · <span class="warn">not cross-origin isolated: serve this page with COOP/COEP headers, as <code>node threads/playground/serve.js</code> does</span>');
