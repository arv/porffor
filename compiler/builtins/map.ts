import type {} from './porffor.d.ts';

export const __Map_prototype_size$get = function (this: Map) {
  const keys: any[] = Porffor.IR.loadI32(this, 0);
  return keys.length - Porffor.IR.loadI32(this, 16);
};

export const __Map_prototype_has = function (this: Map, key: any) {
  __Porffor_rlock(Porffor.IR.ptr(this) + 20);
  const found: boolean = __Porffor_hashtableLookup(this, key) != -1;
  __Porffor_runlock(Porffor.IR.ptr(this) + 20);
  return found;
};

export const __Map_prototype_get = function (this: Map, key: any) {
  __Porffor_rlock(Porffor.IR.ptr(this) + 20);
  let out: any = undefined;
  const index: i32 = __Porffor_hashtableLookup(this, key);
  if (index != -1) {
    const vals: any[] = Porffor.IR.loadI32(this, 4);
    out = vals[index];
  }

  __Porffor_runlock(Porffor.IR.ptr(this) + 20);
  return out;
};

export const __Map_prototype_set = function (this: Map, key: any, value: any) {
  __Porffor_rlock(Porffor.IR.ptr(this) + 20);
  const vals: any[] = Porffor.IR.loadI32(this, 4);

  const index: i32 = __Porffor_hashtableLookup(this, key);
  if (index != -1) {
    vals[index] = value;
  } else {
    // push the value first so vals stays in sync if append compacts both arrays
    Porffor.array.fastPush(vals, value);
    __Porffor_hashtableAppend(this, key);
  }

  __Porffor_runlock(Porffor.IR.ptr(this) + 20);
  return this;
};

export const __Map_prototype_delete = function (this: Map, key: any) {
  __Porffor_rlock(Porffor.IR.ptr(this) + 20);
  const index: i32 = __Porffor_hashtableLookup(this, key);
  if (index != -1) __Porffor_hashtableTombstone(this, key, index);

  __Porffor_runlock(Porffor.IR.ptr(this) + 20);
  return index != -1;
};

export const __Map_prototype_clear = function (this: Map) {
  __Porffor_rlock(Porffor.IR.ptr(this) + 20);
  const keys: any[] = Porffor.IR.loadI32(this, 0);
  __Porffor_array_ensure(keys, 0);
  keys.length = 0;

  const vals: any[] = Porffor.IR.loadI32(this, 4);
  __Porffor_array_ensure(vals, 0);
  vals.length = 0;

  Porffor.IR.storeI32(this, 8, 0);
  Porffor.IR.storeI32(this, 12, 0);
  Porffor.IR.storeI32(this, 16, 0);
  __Porffor_runlock(Porffor.IR.ptr(this) + 20);
};

export const __Map_prototype_forEach = function (this: Map, callbackFn: any, thisArg: any = undefined) {
  if (Porffor.type(callbackFn) != Porffor.TYPES.function) throw new TypeError('callbackFn is not a function');

  const keys: any[] = Porffor.IR.loadI32(this, 0);
  const vals: any[] = Porffor.IR.loadI32(this, 4);

  // callbackFn can add entries, which must be visited and can move the entries buffer
  // each key read once, with its value under the lock (not across the user callback)
  for (let i: i32 = 0; i < keys.length; i++) {
    __Porffor_rlock(Porffor.IR.ptr(this) + 20);
    const bits: i64 = __Porffor_array_getBits(keys, i);
    const value: any = vals[i];
    __Porffor_runlock(Porffor.IR.ptr(this) + 20);
    if (bits == -1) continue;
    // 0 (keys are never 0): another thread shrank keys meanwhile, past the end now
    if (bits == 0) break;
    callbackFn.call(thisArg, value, __Porffor_array_fromBits(bits), this);
  }
};

export const Map = function (iterable: any): Map {
  if (!new.target) throw new TypeError("Constructor Map requires 'new'");

  const out: Map = __Porffor_hashtableNew(true);
  Porffor.IR.gcBarrier(out, Porffor.TYPES.map);

  if (iterable != null) for (const x of iterable) {
    if (!Porffor.object.isObject(x)) throw new TypeError('Iterator contains non-object');
    Porffor.callThis(__Map_prototype_set, out, x[0], x[1]);
  }

  return out;
};

export const __Map_prototype_keys = function (this: Map) {
  __Porffor_rlock(Porffor.IR.ptr(this) + 20);
  const keys: any[] = Porffor.IR.loadI32(this, 0);
  const keysEntries: i32 = Porffor.IR.loadI32(keys, 4);
  const out: any[] = Porffor.array.new(4);

  const size: i32 = keys.length;
  for (let i: i32 = 0; i < size; i++) {
    if (Porffor.IR.loadU64(keysEntries + i * 8, 0) == -1) continue;
    Porffor.array.fastPush(out, keys[i]);
  }

  __Porffor_runlock(Porffor.IR.ptr(this) + 20);
  return out;
};

export const __Map_prototype_values = function (this: Map) {
  __Porffor_rlock(Porffor.IR.ptr(this) + 20);
  const keys: any[] = Porffor.IR.loadI32(this, 0);
  const keysEntries: i32 = Porffor.IR.loadI32(keys, 4);
  const vals: any[] = Porffor.IR.loadI32(this, 4);
  const out: any[] = Porffor.array.new(4);

  const size: i32 = keys.length;
  for (let i: i32 = 0; i < size; i++) {
    if (Porffor.IR.loadU64(keysEntries + i * 8, 0) == -1) continue;
    Porffor.array.fastPush(out, vals[i]);
  }

  __Porffor_runlock(Porffor.IR.ptr(this) + 20);
  return out;
};

export const __Map_prototype_entries = function (this: Map) {
  __Porffor_rlock(Porffor.IR.ptr(this) + 20);
  const keys: any[] = Porffor.IR.loadI32(this, 0);
  const keysEntries: i32 = Porffor.IR.loadI32(keys, 4);
  const vals: any[] = Porffor.IR.loadI32(this, 4);
  const out: any[] = Porffor.array.new(4);

  const size: i32 = keys.length;
  for (let i: i32 = 0; i < size; i++) {
    if (Porffor.IR.loadU64(keysEntries + i * 8, 0) == -1) continue;
    const entry: any[] = Porffor.array.new(2);
    Porffor.array.fastPush(entry, keys[i]);
    Porffor.array.fastPush(entry, vals[i]);
    Porffor.array.fastPush(out, entry);
  }

  __Porffor_runlock(Porffor.IR.ptr(this) + 20);
  return out;
};

export const __Map_prototype_toString = function (this: Map) { return '[object Map]'; };
export const __Map_prototype_toLocaleString = function (this: Map) { return Porffor.callThis(__Map_prototype_toString, this); };

// https://github.com/tc39/proposal-upsert
export const __Map_prototype_getOrInsert = function (this: Map, key: any, value: any) {
  __Porffor_rlock(Porffor.IR.ptr(this) + 20);
  if (!Porffor.callThis(__Map_prototype_has, this, key)) {
    Porffor.callThis(__Map_prototype_set, this, key, value);
  }

  const out: any = Porffor.callThis(__Map_prototype_get, this, key);
  __Porffor_runlock(Porffor.IR.ptr(this) + 20);
  return out;
};

export const __Map_prototype_getOrInsertComputed = function (this: Map, key: any, callbackFn: any) {
  if (!Porffor.callThis(__Map_prototype_has, this, key)) {
    // not under the lock: callbackFn is user code
    const value: any = callbackFn(key);
    __Porffor_rlock(Porffor.IR.ptr(this) + 20);
    Porffor.callThis(__Map_prototype_set, this, key, value);
    const out: any = Porffor.callThis(__Map_prototype_get, this, key);
    __Porffor_runlock(Porffor.IR.ptr(this) + 20);
    return out;
  }

  return Porffor.callThis(__Map_prototype_get, this, key);
};
