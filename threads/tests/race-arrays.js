// shared arrays: racing pushes keep every element, racing pops take each exactly once, and
// grows / length changes / splice / shift / unshift never let a reader see a torn or
// foreign value
const SCALE = 1; // run.js lowers this for sanitizer and gc stress runs
const N = 4, PER = 5000 * SCALE;
const q = [];
const grid = [];
const ok = v => v === undefined || typeof v === 'number' || (typeof v === 'object' && v !== null && typeof v.t === 'number');

const churn = t => () => {
  let bad = 0;
  for (let i = 0; i < PER; i++) {
    q.push({ t, i });
    grid[(i * 31 + t * 7) % 3000] = (i & 1) ? i : { t };
    if ((i % 50) === 0) grid.length = 1000 + (i % 2000);
    if ((i % 37) === 0) grid.splice(i % 100, 3, t, t);
    if ((i % 41) === 0) grid.shift();
    if ((i % 43) === 0) grid.unshift({ t });
    if (!ok(grid[(i * 17) % 3000])) bad++;
    if ((i % 500) === 0) for (const v of grid) if (!ok(v)) bad++;
  }
  return bad;
};

let ts = [];
for (let t = 0; t < N; t++) ts.push(new Thread(churn(t)));
const bads = ts.map(x => x.join());

const seen = [];
for (let k = 0; k < N * PER; k++) seen.push(0);
for (const e of q) seen[e.t * PER + e.i]++;
let pushOk = q.length === N * PER;
for (let k = 0; k < N * PER; k++) if (seen[k] !== 1) pushOk = false;

const popper = () => {
  const got = [];
  while (true) {
    const e = q.pop();
    if (e === undefined) break;
    got.push(e.t * PER + e.i);
  }
  return got;
};
ts = [];
for (let t = 0; t < N; t++) ts.push(new Thread(popper));
const popped = [];
for (let k = 0; k < N * PER; k++) popped.push(0);
let total = 0;
for (const x of ts) for (const k of x.join()) { popped[k]++; total++; }
let popOk = total === N * PER && q.length === 0;
for (let k = 0; k < N * PER; k++) if (popped[k] !== 1) popOk = false;

console.log(bads.every(b => b === 0) && pushOk && popOk ? 'ok' : 'BAD ' + bads.join(',') + ' push ' + pushOk + ' pop ' + popOk + ' total ' + total);
