# Threads: shared everything

Porffor threads follow WebKit's ["Concurrent JavaScript: It can work!"](https://webkit.org/blog/7846/concurrent-javascript-it-can-work/):
every thread runs in the same heap, so objects, arrays, Maps, closures and globals are shared
by default. Racing accesses are allowed. They may observe any interleaving, but they never
crash, never see a torn or made-up value, and never lose a write to an unrelated property or
element.

```js
const results = [];
const lock = new Lock();
const stats = { done: 0 };
const threads = [];
for (let id = 0; id < 4; id++) threads.push(new Thread(() => {
  results.push(id);                 // a shared array: every push lands
  lock.hold(() => { stats.done++; }); // read-modify-write under a lock
  return id * 2;
}));
console.log(threads.map(t => t.join())); // [ 0, 2, 4, 6 ]
```

[demo.js](demo.js) shows more (Maps, `Atomics.wait`/`notify`, `asyncJoin`):
`node runtime/index.js threads/demo.js`, or `node runtime/index.js native threads/demo.js -o demo`.

A program that never uses `Thread` compiles exactly as before: everything here is only built
in when it does.

## API

- `new Thread(fn)` runs `fn` on a new OS thread.
  - `t.join()` waits for it and returns its result, or rethrows what it threw.
  - `t.asyncJoin()` returns a promise for the result instead, settled by the job loop.
- `new Lock()` is a mutex. `lock.hold(fn)` runs `fn` holding it and releases it however `fn`
  ends. It is not reentrant.
- `new Condition()` is a condition variable.
  - `c.wait(lock, timeoutMs?)` releases the held `lock`, sleeps until notified or out of time
    (returns false if it timed out), then takes the lock again. Wakeups may be spurious, so
    wait in a loop.
  - `c.notifyOne()` and `c.notifyAll()` wake waiters.
- `SharedArrayBuffer` and all of `Atomics` work across threads, including `wait`/`notify`.

## How it works

**Values** are single NaN-boxed 64-bit words everywhere: object properties, array elements,
closure slots and globals that other threads can reach. A racing read sees one whole value.
- Stores are release stores, because a value may point at something just built.
- Loads are relaxed, ordered by their address dependency as in WebKit (acquire under
  ThreadSanitizer, which does not model that). Under gcc the common relaxed loads and stores
  are `volatile` accesses: gcc sizes `__atomic` builtins like calls when inlining, which cost
  threaded builds much of their inlining.

**Objects** keep their entries in a separate block, behind one header word
(entries, size, capacity) that readers load once. Readers never lock.
- A structural change (adding past capacity, deleting, switching between a data property and
  an accessor) copies the block and publishes the new header word.
- The old block stays valid until the next collection, so a reader still walking it sees a
  consistent snapshot.
- A writer that is not the object's owner (see below) locks the object, finds its entry again
  in the live block and retries if what it decided on went stale. A write into a copied-away
  block would otherwise be lost.

**Thread-local objects (WebKit's transition thread locality).** Every object, array, Map/Set
and promise has a lock word, initially the tag of the thread that allocated it.
- The owner writes without locking: one compare of the lock word with its tag.
- Another thread that wants to write requests a takeover. The owner hands the object over (the
  lock word becomes an ordinary lock) at its next *clean point*: a loop back-edge, or waiting
  in `join`, `Atomics.wait`, a lock and so on.
- Ownership established once lasts until the owner's next clean point, so its in-flight
  operations are never interrupted.

**Arrays** keep their elements in a separate block too.
- Capacity never shrinks, and an element is stored before the length grows.
- Moves (`shift`, `splice`...) copy whole words.
- Growing copies the block under the array's lock, or without the lock for its owner.

**Map/Set, promises and generators** take their container's lock for each operation.
- Promises settle once and keep every reaction.
- A generator resumed from two threads at once runs for one and throws "already running" for
  the other.
- Async generators queue their next/throw/return requests and run one at a time, including
  across awaits.

**Builtin state** that used to be process-wide is per thread: regex compiler scratch and
caches, DataView scratch, and builtin array literals. The few tables every thread must share
(the `Symbol.for` registry, the hidden-props store) are locked.

**Garbage collection** stops the world.
- Each thread allocates from its own windows and parks at a safepoint, either in the
  allocator or at a loop's clean point. Its stack and saved registers are scanned
  conservatively, like the main thread's.
- A thread blocked in a wait counts as parked, so it never holds up a collection.

**Wasm**: the same C builds for `wasm32-wasip1-threads` (wasi-sdk/clang). There the 8-byte
loads and stores above stay real atomics, so they never tear. Narrower relaxed ones are plain:
Wasm never tears an aligned access of at most 4 bytes, and its only atomics are sequentially
consistent and checked for alignment.

## Cost

Single-threaded code in a program that uses threads, against the same program built without
them (`bench/` programs and the micro benchmarks in [bench](bench), each also built with
`new Thread(() => 0).join();` appended; cycles on macOS/clang, time on Linux/gcc 12 and on Wasm,
all on Apple silicon; Wasm built with wasi-sdk's clang and run on node's V8). Code layout alone
moves these small programs by 3-6%, so both native builds have their functions 64-byte aligned,
and differences of a percent or two are noise:

| | richards | linked_list | micro_map | object_get | micro_arr | micro_loop |
|---|---|---|---|---|---|---|
| macOS, clang | +3.6% | +3.9% | +1.4% | 0% | 0% | 0% |
| Linux, gcc | +1.4% | +5% | +5.7% | +12% | -16% | 0% |
| Wasm, V8 | +4% | +6% | +1.5% | +4.6% | +4.8% | -2% |

Property reads and writes go through inline caches (`porf_ic_get`/`porf_ic_set` in render.js):
each site remembers where it last found its key, and a hit is a few inline instructions. A
read site that found its key on the receiver's prototype (a method) remembers that prototype
too. A write hit also checks that this thread owns the object, which is what keeps the
ownership check off the slow path and nearly free. What remains:
- **Map/Set** check their container's lock word on every operation (micro_map): for the owner,
  a load and a compare on the way in and a load and a test on the way out. Inside, the values
  are plain words under that lock.
- **Loops** poll for a pending collection or takeover at every back-edge (their clean point),
  a load and a branch per iteration. In a loop as small as object_get's (one property read),
  that poll is a large share of the work.
- **Wasm** keeps its 8-byte accesses atomic: an object's header word, every value (a cache
  hit's two loads, an array element) and the clean points' poll.

## Testing

```sh
node threads/run.js                  # every test in threads/tests, output against tests/*.out
node threads/run.js race-arrays      # just some
node threads/run.js --stress=64      # force a minor collection every 64 allocations
node threads/run.js --tsan           # ThreadSanitizer (clean but for one by-design race)
node threads/run.js --cc=gcc         # another C compiler
```

test262's multi-agent Atomics tests run on threads too: `test262/agent.js` provides
`$262.agent`, with each agent a thread.
