// thread-local objects changing hands: an owner keeps mutating what it allocated (adds,
// deletes, element writes, pushes, map sets) while other threads start writing the same
// things, which takes them over mid-flight. nobody's writes may be lost
const SCALE = 1; // run.js lowers this for sanitizer and gc stress runs
const ROUNDS = 40, N = 3, PER = 2000 * SCALE;
const box = { objs: null, arrs: null, maps: null };
const go = new Int32Array(new SharedArrayBuffer(16));
let bad = 0;

for (let round = 0; round < ROUNDS; round++) {
  Atomics.store(go, 0, 0);
  Atomics.store(go, 1, 0);
  // the owner: allocates, publishes, then keeps changing its own keys and slots
  const owner = new Thread(() => {
    const objs = [], arrs = [], maps = [];
    for (let k = 0; k < 8; k++) { objs.push({ o: 0 }); arrs.push([ 0 ]); maps.push(new Map()); }
    box.objs = objs; box.arrs = arrs; box.maps = maps;
    Atomics.store(go, 0, 1);
    let errs = 0;
    for (let i = 0; i < PER; i++) {
      const k = i & 7;
      objs[k].o = i;
      objs[k]['tmp' + (i & 3)] = i;
      if ((i & 3) === 3) delete objs[k]['tmp' + (i & 1)];
      arrs[k][0] = i;
      if ((i & 15) === 0) arrs[k].push(-1);
      maps[k].set('o', i);
      if (objs[k].o !== i || arrs[k][0] !== i || maps[k].get('o') !== i) errs++;
    }
    Atomics.store(go, 1, 1);
    return errs;
  });
  while (Atomics.load(go, 0) === 0) {}
  const objs = box.objs, arrs = box.arrs, maps = box.maps;
  // the others: write their own keys / slots / map keys into the owner's objects
  const ts = [];
  for (let t = 0; t < N; t++) ts.push(new Thread(() => {
    let errs = 0;
    for (let i = 0; i < PER; i++) {
      const k = (i + t) & 7;
      objs[k]['t' + t] = i;
      arrs[k][1 + t] = i;
      maps[k].set(t, i);
      if (objs[k]['t' + t] !== i || arrs[k][1 + t] !== i || maps[k].get(t) !== i) errs++;
    }
    return errs;
  }));
  bad += owner.join();
  for (const x of ts) bad += x.join();
  // every thread's last write to each of its keys survived
  for (let t = 0; t < N; t++) for (let k = 0; k < 8; k++) {
    let last = -1;
    for (let i = 0; i < PER; i++) if (((i + t) & 7) === k) last = i;
    if (objs[k]['t' + t] !== last || arrs[k][1 + t] !== last || maps[k].get(t) !== last) bad++;
  }
  for (let k = 0; k < 8; k++) {
    let last = -1;
    for (let i = 0; i < PER; i++) if ((i & 7) === k) last = i;
    if (objs[k].o !== last || arrs[k][0] !== last || maps[k].get('o') !== last) bad++;
  }
}

// two threads taking over each other's objects at the same time, while both stay busy
const pairs = new Int32Array(new SharedArrayBuffer(8));
const mine = [ null, null ];
const swap = id => () => {
  const own = [];
  for (let k = 0; k < 64; k++) own.push({ v: 0 });
  mine[id] = own;
  Atomics.add(pairs, 0, 1);
  while (Atomics.load(pairs, 0) < 2) {}
  const theirs = mine[1 - id];
  let errs = 0;
  for (let i = 0; i < 5000; i++) {
    own[i & 63].v = i;
    theirs[i & 63]['from' + id] = i;
    if (theirs[i & 63]['from' + id] !== i) errs++;
  }
  return errs;
};
const s0 = new Thread(swap(0)), s1 = new Thread(swap(1));
bad += s0.join() + s1.join();

// objects owned by a thread that has finished
const done = new Thread(() => { const o = { a: 1 }; const arr = [ 1, 2 ]; return [ o, arr ]; }).join();
const later = new Thread(() => { done[0].b = 2; done[1].push(3); return done[0].a + done[0].b + done[1].length; });
if (later.join() !== 6) bad++;

console.log(bad === 0 ? 'ok' : 'BAD ' + bad);
