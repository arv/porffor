// Atomics across threads: exact counters, a futex mutex from compareExchange + wait/notify,
// and a thread asleep in wait while others collect garbage
const SCALE = 1; // run.js lowers this for sanitizer and gc stress runs
const N = 4;
const i32 = new Int32Array(new SharedArrayBuffer(64));
const b64 = new BigInt64Array(new SharedArrayBuffer(16));

let ts = [];
for (let t = 0; t < N; t++) ts.push(new Thread(() => {
  for (let i = 0; i < 100000 * SCALE; i++) Atomics.add(i32, 0, 1);
  for (let i = 0; i < 20000 * SCALE; i++) Atomics.add(b64, 0, 1n);
  return 0;
}));
for (const x of ts) x.join();
console.log('counters', Atomics.load(i32, 0) === N * 100000 * SCALE, Atomics.load(b64, 0) === BigInt(N * 20000 * SCALE));

// i32[2] is the lock (0 free, 1 held, 2 held with waiters), i32[3] a plain counter it guards
const lock = () => {
  let c = Atomics.compareExchange(i32, 2, 0, 1);
  if (c === 0) return;
  if (c !== 2) c = Atomics.exchange(i32, 2, 2);
  while (c !== 0) {
    Atomics.wait(i32, 2, 2);
    c = Atomics.exchange(i32, 2, 2);
  }
};
const unlock = () => {
  if (Atomics.sub(i32, 2, 1) !== 1) {
    Atomics.store(i32, 2, 0);
    Atomics.notify(i32, 2, 1);
  }
};
ts = [];
for (let t = 0; t < N; t++) ts.push(new Thread(() => {
  for (let i = 0; i < 20000 * SCALE; i++) {
    lock();
    i32[3] = i32[3] + 1;
    unlock();
  }
  return 0;
}));
for (const x of ts) x.join();
console.log('mutex', i32[3] === N * 20000 * SCALE);

// a waiter parked in Atomics.wait must not hold up collections on other threads
const sleeper = new Thread(() => Atomics.wait(i32, 4, 0));
const churner = new Thread(() => {
  let keep = [];
  for (let i = 0; i < 200000; i++) { keep.push({ i, s: 'x' + i }); if (keep.length > 1000) keep = []; }
  return keep.length;
});
churner.join();
Atomics.store(i32, 4, 1);
let woke = 0;
while (woke === 0) woke = Atomics.notify(i32, 4);
console.log('wait', sleeper.join(), woke);
