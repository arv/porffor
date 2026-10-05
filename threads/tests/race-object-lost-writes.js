// lost writes: every thread writes only its own keys while all threads churn the shared
// object (grow, delete, value <-> accessor), which copies its entries block. a write that
// lands in a copied-away block is lost, so reading back your own key must give what you wrote
const SCALE = 1; // run.js lowers this for sanitizer and gc stress runs
const shared = {};
const N = 4, ITER = 20000 * SCALE, ADDS = 200;

const worker = t => () => {
  let bad = 0;
  const mine = ['a' + t, 'b' + t, 'c' + t];
  for (let i = 0; i < ITER; i++) {
    const k = mine[i % 3];
    shared[k] = i;
    if (shared[k] !== i) bad++;

    const tk = 't' + t + '_' + (i % 50);
    if ((i & 1) === 0) shared[tk] = i;
      else delete shared[tk];

    if ((i % 97) === 0) Object.defineProperty(shared, 'acc' + t, { get() { return t; }, configurable: true });
    if ((i % 97) === 50) Object.defineProperty(shared, 'acc' + t, { value: t, configurable: true, writable: true });
  }

  for (let j = 0; j < 3; j++) {
    const last = ITER - 1 - ((ITER - 1 - j) % 3);
    if (shared[mine[j]] !== last) bad++;
  }

  for (let j = 0; j < ADDS; j++) shared['u' + t + '_' + j] = j;
  return bad;
};

const ts = [];
for (let t = 0; t < N; t++) ts.push(new Thread(worker(t)));
const bads = ts.map(x => x.join());

let missing = 0;
for (let t = 0; t < N; t++) for (let j = 0; j < ADDS; j++) if (shared['u' + t + '_' + j] !== j) missing++;
let ukeys = 0;
for (const k of Object.keys(shared)) if (k[0] === 'u') ukeys++;
console.log(bads.every(b => b === 0) && missing === 0 && ukeys === N * ADDS ? 'ok' : 'BAD ' + bads.join(',') + ' missing ' + missing + ' ukeys ' + ukeys);
