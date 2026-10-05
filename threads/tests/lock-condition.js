// Lock and Condition: a counter under hold(), a bounded buffer with two conditions,
// misuse errors, and a timed wait
const SCALE = 1; // run.js lowers this for sanitizer and gc stress runs
const N = 4, PER = 20000 * SCALE;
const lock = new Lock();
const box = { n: 0 };
let ts = [];
for (let t = 0; t < N; t++) ts.push(new Thread(() => {
  for (let i = 0; i < PER; i++) lock.hold(() => { box.n = box.n + 1; });
  return 0;
}));
for (const x of ts) x.join();
console.log('hold', box.n === N * PER);

const qlock = new Lock(), notEmpty = new Condition(), notFull = new Condition();
const queue = [];
const CAP = 8, ITEMS = 5000 * SCALE;
const producers = [], consumers = [];
for (let p = 0; p < 2; p++) producers.push(new Thread(() => {
  for (let i = 0; i < ITEMS; i++) qlock.hold(() => {
    while (queue.length >= CAP) notFull.wait(qlock);
    queue.push(p * ITEMS + i);
    notEmpty.notifyOne();
  });
  return 0;
}));
for (let c = 0; c < 2; c++) consumers.push(new Thread(() => {
  let sum = 0, got = 0;
  for (let i = 0; i < ITEMS; i++) qlock.hold(() => {
    while (queue.length === 0) notEmpty.wait(qlock);
    sum += queue.shift();
    got++;
    notFull.notifyOne();
  });
  return [ got, sum ];
}));
for (const x of producers) x.join();
let total = 0, sum = 0;
for (const x of consumers) { const r = x.join(); total += r[0]; sum += r[1]; }
const n2 = 2 * ITEMS;
console.log('queue', total === n2, sum === n2 * (n2 - 1) / 2, queue.length === 0);

for (const bad of [ () => lock.hold(() => lock.hold(() => 0)), () => notEmpty.wait(qlock), () => lock.hold(5) ])
  try { bad(); console.log('no throw'); } catch (e) { console.log(e.constructor.name); }
console.log('released after throw', lock.hold(() => 'ok'));

const t0 = Date.now();
const timedOut = qlock.hold(() => notEmpty.wait(qlock, 30));
console.log('timed', timedOut, Date.now() - t0 >= 25, String(lock), String(notEmpty));
