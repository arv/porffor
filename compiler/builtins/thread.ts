import type {} from './porffor.d.ts';

// shared-memory threads (webkit's "concurrent javascript" strawman): every thread
// runs in the same heap, so closures, globals and objects are shared by default

// __memory layout__
// per thread (24):
//  result or thrown value (jsval, 8)
//  function (jsval, 8)
//  state (u8, 1) - 0 running, 1 done (set by the C runtime when the thread finishes)
//  threw (u8, 1)
//  padding (u8 x6, 6)

// runs on the new thread: the C runtime calls this once with the Thread object
export const __Porffor_thread_run = (thread: Thread): void => {
  const fn: any = Porffor.IR.loadJv(thread, 8);
  let out: any;
  try {
    out = Porffor.callThis(fn, undefined);
  } catch (e) {
    out = e;
    Porffor.IR.storeU8(thread, 17, 1);
  }
  // the Thread object is usually old by now: remember the young result
  Porffor.IR.storeJv(thread, 0, out);
  Porffor.IR.gcBarrierValue(thread, Porffor.TYPES.thread, out);
};

export const Thread = function (fn: any): Thread {
  if (!new.target) throw new TypeError("Constructor Thread requires 'new'");
  if (Porffor.type(fn) != Porffor.TYPES.function) throw new TypeError('Thread: argument must be a function');

  const thread: Thread = Porffor.malloc(24);
  Porffor.IR.storeJv(thread, 0, undefined);
  Porffor.IR.storeJv(thread, 8, fn);
  Porffor.IR.storeU8(thread, 16, 0);
  Porffor.IR.storeU8(thread, 17, 0);

  const ptr: i32 = Porffor.IR.ptr(thread);
  let started: i32 = 0;
  Porffor.c`started = porf_thread_spawn((u32)ptr);`;
  if (started == 0) {
    // no thread available: run to completion here so join() still works
    __Porffor_thread_run(thread);
    Porffor.IR.storeU8(thread, 16, 1);
  }

  return thread;
};

export const __Thread_prototype_join = function (this: Thread) {
  const ptr: i32 = Porffor.IR.ptr(this);
  Porffor.c`porf_thread_join((u32)ptr);`;
  if (Porffor.IR.loadU8(this, 17) == 1) throw Porffor.IR.loadJv(this, 0);
  return Porffor.IR.loadJv(this, 0);
};

// threads awaited through asyncJoin, each followed by its promise
const pendingJoins: any[] = [];

// the result as a promise, for code that should not block: the job loop settles it once it
// has nothing else to run (see __Porffor_thread_settleJoin)
export const __Thread_prototype_asyncJoin = function (this: Thread) {
  const promise: Promise = __Porffor_promise_create();
  Porffor.array.fastPush(pendingJoins, this);
  Porffor.array.fastPush(pendingJoins, promise);
  return promise;
};

// settles one asyncJoin promise, a finished thread's first, else waiting (as parked) for
// the oldest. false when none are pending
export const __Porffor_thread_settleJoin = (): boolean => {
  const n: i32 = pendingJoins.length;
  if (n == 0) return false;

  let pick: i32 = 0;
  for (let i: i32 = 0; i < n; i += 2) {
    const threadPtr: i32 = Porffor.IR.ptr(pendingJoins[i]);
    let done: i32 = 0;
    Porffor.c`done = __atomic_load_n((u8*)(MEM + (u32)threadPtr + 16u), __ATOMIC_ACQUIRE);`;
    if (done) {
      pick = i;
      break;
    }
  }

  const thread: Thread = pendingJoins[pick];
  const promise: any = pendingJoins[pick + 1];
  pendingJoins.splice(pick, 2);

  const threadPtr: i32 = Porffor.IR.ptr(thread);
  Porffor.c`
#if PORF_THREADED
porf_thread_join((u32)threadPtr);
#endif
`;
  if (Porffor.IR.loadU8(thread, 17) == 1) __ecma262_RejectPromise(promise, Porffor.IR.loadJv(thread, 0));
    else __Porffor_promise_resolve(Porffor.IR.loadJv(thread, 0), promise);
  return true;
};

export const __Thread_prototype_toString = function (this: Thread) { return '[object Thread]'; };
export const __Thread_prototype_toLocaleString = function (this: Thread) { return Porffor.callThis(__Thread_prototype_toString, this); };

// Lock and Condition (also from the strawman): a futex mutex and condition variable on
// the same waiting as Atomics.wait/notify, so a blocked thread never holds up collections

// __memory layout__
// per lock (8):
//  state (u32, 4) - 0 free, 1 held, 2 held with waiters
//  holder (u32, 4) - the holding thread's id, 0 when free
// per condition (8):
//  sequence (u32, 4) - bumped by every notify, waiters sleep while it is unchanged
//  padding (u32, 4)

export const Lock = function (): Lock {
  if (!new.target) throw new TypeError("Constructor Lock requires 'new'");

  const lock: Lock = Porffor.malloc(8);
  Porffor.IR.storeI32(lock, 0, 0);
  Porffor.IR.storeI32(lock, 4, 0);
  return lock;
};

export const __Porffor_lock_acquire = (lock: Lock): void => {
  const lockAddr: i32 = Porffor.IR.ptr(lock);
  let selfId: i32 = 0;
  Porffor.c`selfId = (i32)porf_self_id();`;
  // not reentrant: taking it again would wait forever
  if (Porffor.IR.loadI32(lock, 4) == selfId) throw new TypeError('Lock is already held by this thread');

  Porffor.c`porf_mutex_lock((u32)lockAddr);`;
  Porffor.IR.storeI32(lock, 4, selfId);
};

export const __Porffor_lock_release = (lock: Lock): void => {
  const lockAddr: i32 = Porffor.IR.ptr(lock);
  Porffor.IR.storeI32(lock, 4, 0);
  Porffor.c`porf_mutex_unlock((u32)lockAddr);`;
};

// runs fn holding the lock, releasing it however fn returns
export const __Lock_prototype_hold = function (this: Lock, fn: any) {
  if (Porffor.type(fn) != Porffor.TYPES.function) throw new TypeError('Lock.prototype.hold: argument must be a function');

  __Porffor_lock_acquire(this);
  let out: any;
  try {
    out = Porffor.callThis(fn, undefined);
  } catch (e) {
    __Porffor_lock_release(this);
    throw e;
  }

  __Porffor_lock_release(this);
  return out;
};

export const __Lock_prototype_toString = function (this: Lock) { return '[object Lock]'; };
export const __Lock_prototype_toLocaleString = function (this: Lock) { return Porffor.callThis(__Lock_prototype_toString, this); };

export const Condition = function (): Condition {
  if (!new.target) throw new TypeError("Constructor Condition requires 'new'");

  const cond: Condition = Porffor.malloc(8);
  Porffor.IR.storeI32(cond, 0, 0);
  Porffor.IR.storeI32(cond, 4, 0);
  return cond;
};

// releases lock (which must be held), sleeps until notified or out of time (ms), then
// takes lock again. false if it timed out. wakeups may be spurious: wait in a loop
export const __Condition_prototype_wait = function (this: Condition, lock: any, timeout: any) {
  if (Porffor.type(lock) != Porffor.TYPES.lock) throw new TypeError('Condition.prototype.wait: argument must be a Lock');
  let selfId: i32 = 0;
  Porffor.c`selfId = (i32)porf_self_id();`;
  if (Porffor.IR.loadI32(lock, 4) != selfId) throw new TypeError('Condition.prototype.wait: the Lock must be held');

  let timeoutMs: number = Infinity;
  if (Porffor.type(timeout) != Porffor.TYPES.undefined) {
    timeoutMs = ecma262.ToNumber(timeout);
    if (timeoutMs != timeoutMs) timeoutMs = Infinity;
      else if (timeoutMs < 0) timeoutMs = 0;
  }

  // read the sequence before releasing: a notify after that changes it, so no wakeup is lost
  const condAddr: i32 = Porffor.IR.ptr(this);
  let seq: i32 = 0;
  Porffor.c`seq = (i32)__atomic_load_n((u32*)(MEM + (u32)condAddr), __ATOMIC_SEQ_CST);`;
  __Porffor_lock_release(lock);

  let waitResult: i32 = 0;
  Porffor.c`waitResult = porf_atomic_wait((u32)condAddr, 4, (u64)(u32)seq, timeoutMs);`;
  __Porffor_lock_acquire(lock);
  return waitResult != 2;
};

// wake one waiter / all waiters, returning how many were woken
export const __Condition_prototype_notifyOne = function (this: Condition) {
  const condAddr: i32 = Porffor.IR.ptr(this);
  let woken: number = 0;
  Porffor.c`__atomic_fetch_add((u32*)(MEM + (u32)condAddr), 1u, __ATOMIC_SEQ_CST);
woken = porf_atomic_notify((u32)condAddr, 1);`;
  return woken;
};

export const __Condition_prototype_notifyAll = function (this: Condition) {
  const condAddr: i32 = Porffor.IR.ptr(this);
  let woken: number = 0;
  Porffor.c`__atomic_fetch_add((u32*)(MEM + (u32)condAddr), 1u, __ATOMIC_SEQ_CST);
woken = porf_atomic_notify((u32)condAddr, INFINITY);`;
  return woken;
};

export const __Condition_prototype_toString = function (this: Condition) { return '[object Condition]'; };
export const __Condition_prototype_toLocaleString = function (this: Condition) { return Porffor.callThis(__Condition_prototype_toString, this); };
