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

export const __Thread_prototype_toString = function (this: Thread) { return '[object Thread]'; };
export const __Thread_prototype_toLocaleString = function (this: Thread) { return Porffor.callThis(__Thread_prototype_toString, this); };
