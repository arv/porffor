// promises shared by threads: racing resolves settle once, then() racing a resolve never
// loses its reaction, and an await on another thread's promise resumes
const SCALE = 1; // run.js lowers this for sanitizer and gc stress runs
const ROUNDS = 300 * SCALE, THENS = 4, PER = 5;
const counts = new Int32Array(new SharedArrayBuffer(16));
let bad = 0;
// (a loop-body let assigned from a closure reads stale in the loop body: keep the resolver in an object)
const deferred = () => { const d = {}; d.p = new Promise(r => { d.resolve = r; }); return d; };

for (let round = 0; round < ROUNDS; round++) {
  const d = deferred();
  const p = d.p;
  const seen = new Int32Array(new SharedArrayBuffer(8));
  Atomics.store(counts, 0, 0);

  const ts = [];
  for (let t = 0; t < THENS; t++) ts.push(new Thread(() => {
    for (let i = 0; i < PER; i++) p.then(v => {
      Atomics.add(counts, 0, 1);
      // every callback must see the same (winning) value
      const prev = Atomics.compareExchange(seen, 0, 0, v);
      if (prev !== 0 && prev !== v) Atomics.add(seen, 1, 1);
    });
    return 0;
  }));
  for (let t = 1; t <= 2; t++) ts.push(new Thread(() => { d.resolve(t); return 0; }));
  for (const x of ts) x.join();

  if (Atomics.load(counts, 0) !== THENS * PER || Atomics.load(seen, 1) !== 0) bad++;
}

let resolveLater;
const later = new Promise(r => { resolveLater = r; });
const waiter = new Thread(async () => (await later) + 1);
const resolver = new Thread(() => { resolveLater(41); return 0; });
resolver.join();
const res = waiter.join();
Promise.resolve(res).then(v => console.log(bad === 0 ? 'ok' : 'BAD ' + bad, v));
