// runs a compiled program: one shared memory, a "main" worker for _start and a pool of
// workers for its threads (see thread.worker.js)
const CTRL_INTS = 8 + 1024 * 2;
export const MAX_WORKERS = 256;
// the timeline: for each of the first TIMELINE_WORKERS workers, up to TIMELINE_SPANS
// (start, end) times of the threads it ran, in ms since the epoch (end 0 while running)
export const TIMELINE_WORKERS = 64, TIMELINE_SPANS = 1024;

// the limits of the memory a module imports. instantiating it to find out would run its start
// function, which initializes the memory
const memoryLimits = bytes => {
  let p = 8;
  const u = () => { let r = 0, s = 0, b; do { b = bytes[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };
  const name = () => { const n = u(); const t = new TextDecoder().decode(bytes.subarray(p, p + n)); p += n; return t; };
  while (p < bytes.length) {
    const id = bytes[p++], size = u(), end = p + size;
    if (id === 2) {
      for (let n = u(); n > 0; n--) {
        const mod = name(), field = name(), kind = bytes[p++];
        if (kind === 2) {
          const flags = u(), min = u(), max = flags & 1 ? u() : undefined;
          if (mod === 'env' && field === 'memory') return { min, max };
        } else if (kind === 0) u();
        else if (kind === 1) { p++; const f = u(); u(); if (f & 1) u(); }
        else if (kind === 3) p += 2;
        else if (kind === 4) { p++; u(); }
      }
    }
    p = end;
  }
  throw new Error('the module imports no memory');
};

// events: out(fd, text), exit(code), crash(message)
// returns { timeline, spans, workers(), stop() }: spans[i] is how many spans worker i has in
// timeline (worker 0 is main)
export const run = async (bytes, events, pool = navigator.hardwareConcurrency || 4) => {
  const module = await WebAssembly.compile(bytes);
  const { min, max } = memoryLimits(bytes);
  const memory = new WebAssembly.Memory({ initial: min, maximum: max ?? 16384, shared: true });
  const ctrl = new Int32Array(new SharedArrayBuffer(CTRL_INTS * 4));
  const timeline = new Float64Array(new SharedArrayBuffer(TIMELINE_WORKERS * TIMELINE_SPANS * 2 * 8));
  const spans = new Int32Array(new SharedArrayBuffer(TIMELINE_WORKERS * 4));
  const workers = [];
  let done = false;

  const finish = () => {
    if (done) return false;
    done = true;
    for (const w of workers) w?.terminate();
    return true;
  };
  const fail = message => { if (finish()) events.crash(message); };

  const start = (role, slot) => new Promise(resolve => {
    const w = workers[slot] = new Worker(new URL('thread.worker.js', import.meta.url));
    w.onmessage = ({ data }) => {
      if (done) return;
      switch (data.type) {
        case 'ready': resolve(); break;
        case 'out': events.out(data.fd, data.text); break;
        case 'grow':
          if (workers.length >= MAX_WORKERS) fail(`more than ${MAX_WORKERS - 1} threads at once`);
          else start('thread', workers.length);
          break;
        case 'exit': if (finish()) events.exit(data.code); break;
        case 'crash': fail(data.message); break;
      }
    };
    w.onerror = e => { e.preventDefault(); fail(e.message || 'a worker failed'); resolve(); };
    w.postMessage({ role, module, memory, ctrl, timeline, spans, slot });
  });

  // a pool is ready before main starts, so the first threads do not wait for workers to start
  workers.length = 1;
  await Promise.all(Array.from({ length: pool }, (_, i) => start('thread', i + 1)));
  if (!done) start('main', 0);

  return { timeline, spans, workers: () => workers.length, stop: finish };
};
