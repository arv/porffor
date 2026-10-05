// one generator, resumed by several threads at once: each next() either runs it (values
// stay a strict sequence, none lost or repeated) or throws "already running"
const SCALE = 1; // run.js lowers this for sanitizer and gc stress runs
function* counter() { let i = 0; while (true) { let spin = 0; for (let k = 0; k < 50; k++) spin += k; yield i++; } }
const g = counter();
const N = 4;
const ts = [];
for (let t = 0; t < N; t++) ts.push(new Thread(() => {
  const got = []; let busy = 0;
  for (let i = 0; i < 20000 * SCALE; i++) {
    try { got.push(g.next().value); } catch (e) { if (e instanceof TypeError) busy++; else throw e; }
  }
  return [ got, busy ];
}));
const all = [];
let busy = 0;
for (const x of ts) { const r = x.join(); for (const v of r[0]) all.push(v); busy += r[1]; }
all.sort((a, b) => a - b);
let ok = true;
for (let i = 0; i < all.length; i++) if (all[i] !== i) ok = false;
console.log(ok ? 'ok' : 'BAD', all.length + busy === N * 20000 * SCALE);
function* selfish() { yield gen2.next(); }
const gen2 = selfish();
try { gen2.next(); console.log('no throw'); } catch (e) { console.log(e.constructor.name); }
