// Threads in Porffor share one heap: every thread sees the same objects, arrays,
// Maps and closures, with no copying and no message passing.

const results = [];          // a shared array: pushes from several threads all land
const sums = new Map();      // a shared Map
const stats = { done: 0 };   // a plain shared object
const lock = new Lock();     // for read-modify-write sequences like done++

const work = id => {
  let sum = 0;
  for (let i = 0; i < 2_000_000; i++) sum += i % (id + 2);
  results.push(id);
  sums.set(id, sum);
  lock.hold(() => { stats.done++; });
  return sum;
};

// each new Thread runs its function on its own OS thread (a Web Worker here)
const threads = [];
for (let id = 0; id < 4; id++) threads.push(new Thread(() => work(id)));

// join() waits for a thread and returns its result, or rethrows what it threw
console.log('totals:', threads.map(t => t.join()).join(', '));
console.log('pushed:', results.length, 'map entries:', sums.size, 'done:', stats.done);

// Atomics on shared memory: block a thread until another one signals
const flag = new Int32Array(new SharedArrayBuffer(4));
const waiter = new Thread(() => {
  while (Atomics.load(flag, 0) === 0) Atomics.wait(flag, 0, 0);
  return 'woken up';
});
Atomics.store(flag, 0, 1);
Atomics.notify(flag, 0);
console.log('waiter:', waiter.join());

// asyncJoin() gives a promise instead of blocking
new Thread(() => 6 * 7).asyncJoin().then(v => console.log('asyncJoin:', v));
