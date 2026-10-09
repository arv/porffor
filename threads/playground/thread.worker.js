// runs Wasm threads for the playground: each is a Web Worker with its own instance of the
// program over the one shared memory. the page starts a "main" worker, which runs _start, and a
// pool of thread workers, which take wasi thread-spawn requests from a queue in shared memory
// (the spawning thread may block right away, in a join say, so it cannot wait for a new worker
// to start: it queues the request and asks the page for another worker if none is idle)

// ctrl, an Int32Array over a SharedArrayBuffer: these slots, then QUEUE (tid, arg) pairs
const NEXT_TID = 0, HEAD = 1, TAIL = 2, PENDING = 3, IDLE = 4, CTRL = 8, QUEUE = 1024;

const TIMELINE_WORKERS = 64, TIMELINE_SPANS = 1024; // as in runner.js

let memory, ctrl, timeline, spans, slot;

// record when this worker starts and finishes running a thread, for the page's timeline
const begin = () => {
  const n = slot < TIMELINE_WORKERS ? Atomics.load(spans, slot) : TIMELINE_SPANS;
  if (n >= TIMELINE_SPANS) return;
  timeline[(slot * TIMELINE_SPANS + n) * 2] = performance.timeOrigin + performance.now();
  Atomics.store(spans, slot, n + 1);
};
const end = () => {
  const n = slot < TIMELINE_WORKERS ? Atomics.load(spans, slot) : 0;
  if (n > 0 && n <= TIMELINE_SPANS) timeline[(slot * TIMELINE_SPANS + n - 1) * 2 + 1] = performance.timeOrigin + performance.now();
};

class Exit extends Error {
  constructor(code) { super(`exit ${code}`); this.code = code; }
}

const post = (type, data) => postMessage({ type, ...data });

const decoders = {};
const out = (fd, bytes) => {
  const d = decoders[fd] ??= new TextDecoder();
  post('out', { fd, text: d.decode(bytes, { stream: true }) });
};

// a WASI preview1 host: just what Porffor's programs use; the rest answer ENOSYS
const SUCCESS = 0, EBADF = 8, ESPIPE = 70, ENOSYS = 52;
const view = () => new DataView(memory.buffer);
const bytes = (ptr, len) => new Uint8Array(memory.buffer, ptr, len);
const now = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)) * 1000n;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

const wasi = {
  args_sizes_get(argc, size) { view().setUint32(argc, 1, true); view().setUint32(size, 5, true); return SUCCESS; },
  args_get(argv, buf) { view().setUint32(argv, buf, true); bytes(buf, 5).set([ 109, 97, 105, 110, 0 ]); return SUCCESS; }, // "main"
  environ_sizes_get(count, size) { view().setUint32(count, 0, true); view().setUint32(size, 0, true); return SUCCESS; },
  environ_get() { return SUCCESS; },
  clock_res_get(id, res) { view().setBigUint64(res, 1000n, true); return SUCCESS; },
  clock_time_get(id, precision, time) { view().setBigUint64(time, now(), true); return SUCCESS; },
  fd_write(fd, iovs, iovsLen, written) {
    if (fd !== 1 && fd !== 2) return EBADF;
    const v = view();
    let n = 0;
    for (let i = 0; i < iovsLen; i++) {
      const ptr = v.getUint32(iovs + i * 8, true), len = v.getUint32(iovs + i * 8 + 4, true);
      // copy out of shared memory: TextDecoder does not take shared views
      out(fd, bytes(ptr, len).slice());
      n += len;
    }
    v.setUint32(written, n, true);
    return SUCCESS;
  },
  fd_read(fd, iovs, iovsLen, read) { view().setUint32(read, 0, true); return fd === 0 ? SUCCESS : EBADF; },
  fd_fdstat_get(fd, stat) {
    if (fd > 2) return EBADF;
    const v = view();
    v.setUint8(stat, 2); // a character device
    v.setUint16(stat + 2, 0, true);
    v.setBigUint64(stat + 8, 0xffffffffn, true);
    v.setBigUint64(stat + 16, 0xffffffffn, true);
    return SUCCESS;
  },
  fd_seek(fd) { return fd <= 2 ? ESPIPE : EBADF; },
  fd_close() { return SUCCESS; },
  fd_prestat_get() { return EBADF; }, // no preopened directories
  random_get(buf, len) {
    for (let i = 0; i < len; i += 65536) {
      const chunk = new Uint8Array(Math.min(65536, len - i));
      crypto.getRandomValues(chunk);
      bytes(buf + i, chunk.length).set(chunk);
    }
    return SUCCESS;
  },
  sched_yield() { return SUCCESS; },
  // sleeping: clock subscriptions only
  poll_oneoff(subs, events, n, nevents) {
    const v = view();
    let wait = Infinity, first = -1;
    for (let i = 0; i < n; i++) {
      const s = subs + i * 48;
      if (v.getUint8(s + 8) !== 0) continue;
      const timeout = v.getBigUint64(s + 24, true), abs = v.getUint16(s + 40, true) & 1;
      const ns = Number(abs ? timeout - now() : timeout);
      if (ns < wait) { wait = ns; first = i; }
    }
    if (first < 0) return ENOSYS;
    if (wait > 0) Atomics.wait(sleeper, 0, 0, wait / 1e6);
    const e = events;
    v.setBigUint64(e, v.getBigUint64(subs + first * 48, true), true);
    v.setUint16(e + 8, 0, true);
    v.setUint8(e + 10, 0);
    v.setUint32(nevents, 1, true);
    return SUCCESS;
  },
  proc_exit(code) { throw new Exit(code); }
};

const spawn = arg => {
  const tid = Atomics.add(ctrl, NEXT_TID, 1) + 1;
  const tail = Atomics.add(ctrl, TAIL, 1);
  if (tail - Atomics.load(ctrl, HEAD) >= QUEUE) return -1;
  const q = CTRL + (tail % QUEUE) * 2;
  Atomics.store(ctrl, q + 1, arg);
  Atomics.store(ctrl, q, tid);
  const pending = Atomics.add(ctrl, PENDING, 1) + 1;
  Atomics.notify(ctrl, PENDING, 1);
  // a worker counts itself out of IDLE before it claims a request, so this never misses
  // that the request needs a new worker (at worst it asks for one too many)
  if (Atomics.load(ctrl, IDLE) < pending) post('grow');
  return tid;
};

const instantiate = module => {
  const imports = { env: { memory }, wasi: { 'thread-spawn': spawn }, wasi_snapshot_preview1: {} };
  for (const i of WebAssembly.Module.imports(module))
    if (i.module === 'wasi_snapshot_preview1') imports.wasi_snapshot_preview1[i.name] = wasi[i.name] ?? (() => ENOSYS);
  return new WebAssembly.Instance(module, imports);
};

// a Wasm trap or proc_exit ends the whole program, as it would a process
const run = f => {
  try {
    f();
    return true;
  } catch (e) {
    if (e instanceof Exit) post('exit', { code: e.code });
    else post('crash', { message: String(e?.message ?? e), stack: e?.stack });
    return false;
  }
};

onmessage = ({ data }) => {
  ({ memory, ctrl, timeline, spans, slot } = data);
  const instance = instantiate(data.module);
  if (data.role === 'main') {
    begin();
    const ok = run(() => instance.exports._start());
    end();
    if (ok) post('exit', { code: 0 });
    return;
  }

  post('ready');
  Atomics.add(ctrl, IDLE, 1);
  while (true) {
    let pending;
    while ((pending = Atomics.load(ctrl, PENDING)) === 0) Atomics.wait(ctrl, PENDING, 0);
    Atomics.sub(ctrl, IDLE, 1);
    if (Atomics.compareExchange(ctrl, PENDING, pending, pending - 1) !== pending) {
      Atomics.add(ctrl, IDLE, 1);
      continue;
    }
    const q = CTRL + (Atomics.add(ctrl, HEAD, 1) % QUEUE) * 2;
    let tid;
    while ((tid = Atomics.load(ctrl, q)) === 0) Atomics.wait(ctrl, q, 0);
    const arg = Atomics.load(ctrl, q + 1);
    Atomics.store(ctrl, q, 0);
    begin();
    const ok = run(() => instance.exports.wasi_thread_start(tid, arg));
    end();
    if (!ok) return;
    Atomics.add(ctrl, IDLE, 1);
  }
};
