// shared Map/Set: each thread owns its keys (set, read back, delete) while all of them
// update shared keys and a shared Set and iterate both. no lost entries, no torn or
// foreign values, iteration never sees a tombstone
const SCALE = 1; // run.js lowers this for sanitizer and gc stress runs
const N = 4, PER = 3000 * SCALE;
const m = new Map();
const s = new Set();
const okv = v => typeof v === 'number' || typeof v === 'string';

const worker = t => () => {
  let bad = 0;
  for (let i = 0; i < PER; i++) {
    const k = 't' + t + '_' + i;
    m.set(k, i);
    if (m.get(k) !== i) bad++;
    if ((i & 1) === 1) m.delete('t' + t + '_' + (i - 1));
    m.set('shared' + (i % 10), 't' + t);
    s.add(i % 100);
    s.add('t' + t);
    if ((i % 7) === 0) s.delete(i % 100);
    if ((i % 300) === 0) {
      for (const [kk, vv] of m) if (typeof kk !== 'string' || !okv(vv)) bad++;
      m.forEach((vv, kk) => { if (typeof kk !== 'string' || !okv(vv)) bad++; });
      for (const x of s) if (!okv(x)) bad++;
      for (const kk of m.keys()) if (typeof kk !== 'string') bad++;
    }
  }
  return bad;
};

const ts = [];
for (let t = 0; t < N; t++) ts.push(new Thread(worker(t)));
const bads = ts.map(x => x.join());

let missing = 0, extra = 0;
for (let t = 0; t < N; t++) for (let i = 0; i < PER; i++) {
  const k = 't' + t + '_' + i;
  if ((i & 1) === 1) { if (m.get(k) !== i) missing++; }
    else if (m.has(k)) extra++;
}
let sharedOk = true;
for (let j = 0; j < 10; j++) { const v = m.get('shared' + j); if (typeof v !== 'string' || v[0] !== 't') sharedOk = false; }
let setOk = s.size <= 100 + N;
for (let t = 0; t < N; t++) if (!s.has('t' + t)) setOk = false;
const sizeOk = m.size === N * PER / 2 + 10;

console.log(bads.every(b => b === 0) && missing === 0 && extra === 0 && sharedOk && setOk && sizeOk ? 'ok'
  : 'BAD ' + bads.join(',') + ' missing ' + missing + ' extra ' + extra + ' shared ' + sharedOk + ' set ' + setOk + ' size ' + m.size);
