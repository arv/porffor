// Symbol.for from many threads at once: every thread must get the one symbol per key,
// including keys first registered concurrently
const N = 6, KEYS = 400;
const go = new Int32Array(new SharedArrayBuffer(4));
const ts = [];
for (let t = 0; t < N; t++) ts.push(new Thread(() => {
  while (Atomics.load(go, 0) === 0) {}
  const out = [];
  for (let i = 0; i < KEYS; i++) out.push(Symbol.for('k' + ((i * (t + 1)) % KEYS)));
  return out;
}));
Atomics.store(go, 0, 1);
let bad = 0;
const all = ts.map(t => t.join());
for (let t = 0; t < N; t++) for (let i = 0; i < KEYS; i++) {
  const k = 'k' + ((i * (t + 1)) % KEYS);
  if (all[t][i] !== Symbol.for(k)) bad++;
  if (Symbol.keyFor(all[t][i]) !== k) bad++;
}
if (Symbol.keyFor(Symbol('x')) !== undefined) bad++;
console.log(bad === 0 ? 'ok' : 'BAD ' + bad);
