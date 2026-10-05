// takeover while the owner is busy with what is taken: the owner publishes a fresh object
// and array and churns them (adds, deletes, pushes) right away; another thread takes each
// over the moment it appears. both check their own keys and slots afterwards
const SCALE = 1; // run.js lowers this for sanitizer and gc stress runs
const ROUNDS = 20000 * SCALE;
const box = { o: null, a: null, n: 0 };
const flag = new Int32Array(new SharedArrayBuffer(16));

const owner = new Thread(() => {
  let errs = 0;
  for (let r = 1; r <= ROUNDS; r++) {
    const o = { base: r };
    const a = [ r ];
    box.o = o; box.a = a; box.n = r;
    for (let j = 0; j < 12; j++) { o['k' + j] = j + r; a.push(j); }
    for (let j = 0; j < 12; j += 2) delete o['k' + j];
    for (let j = 1; j < 12; j += 2) if (o['k' + j] !== j + r) errs++;
    for (let j = 0; j < 12; j += 2) if (('k' + j) in o) errs++;
    if (a.length < 13 || a[0] !== r) errs++;
  }
  Atomics.store(flag, 0, 1);
  return errs;
});

const taker = new Thread(() => {
  let errs = 0, last = 0, taken = 0;
  while (Atomics.load(flag, 0) === 0) {
    const n = box.n;
    if (n === last) continue;
    const o = box.o, a = box.a;
    last = n;
    o.f = n;
    a[100] = n;
    if (o.f !== n || a[100] !== n) errs++;
    taken++;
  }
  return [ errs, taken ];
});

const e1 = owner.join();
const [ e2, taken ] = taker.join();
console.log(e1 === 0 && e2 === 0 ? 'ok' : 'BAD ' + e1 + ' ' + e2, taken > 100);
