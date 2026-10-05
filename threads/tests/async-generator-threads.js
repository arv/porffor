// one async generator, next() from several threads at once: requests run in turn across the
// body's awaits, so every value goes to exactly one request and every await gets its own value
const SCALE = 1; // run.js lowers this for sanitizer and gc stress runs
const K = 3000 * SCALE, N = 4, PER = 800 * SCALE;
async function* counter() {
  for (let i = 0; i < K; i++) {
    const v = await Promise.resolve().then(() => i);
    if (v !== i) throw new Error('await got ' + v + ' for ' + i);
    yield v;
  }
}
const gen = counter();
const got = [];
const errs = [];
let dones = 0;
const go = new Int32Array(new SharedArrayBuffer(4));
const ts = [];
for (let t = 0; t < N; t++) ts.push(new Thread(() => {
  while (Atomics.load(go, 0) === 0) {}
  for (let k = 0; k < PER; k++) gen.next().then(r => { if (r.done) dones++; else got.push(r.value); }, e => errs.push(String(e)));
  return 0;
}));
Atomics.store(go, 0, 1);
for (const t of ts) t.join();
Promise.resolve().then(() => {
  const seen = new Set(got);
  let inRange = true;
  for (const v of got) if (!(v >= 0 && v < K)) inRange = false;
  console.log(errs.length === 0 && got.length === K && seen.size === K && inRange && dones === N * PER - K ? 'ok' : 'BAD got ' + got.length + ' distinct ' + seen.size + ' errs ' + errs.length + ' ' + errs.slice(0, 2).join('; ') + ' dones ' + dones);
});
