import type {} from './porffor.d.ts';

// __memory layout__
// per object (24):
//  shape (u64, 8): entries pointer (u32) | size (u16) << 32 | capacity (u16) << 48.
//   always published in one store, and read in one load where entries are walked, so a
//   reader racing a grow/delete on another thread never pairs a size with the wrong block
//  prototype (jsbits, 8)
//  root flags (u8, 1):
//   inextensible - 0b0001
//  padding (u8 x3, 3)
//  lock (u32, 4): held by a thread adding/removing entries (no-op without threads)
// entries start inline at +24 until the first grow
// per entry (24):
//  key - hash (u32, 4)
//  key - value (u32, 4)
//  value (jsbits, 8) or accessor pair (u32, 4 each)
//  flags (u8, 1):
//   accessor - 0b0001
//   configurable - 0b0010
//   enumerable - 0b0100
//   writable - 0b1000
//  padding (u8, 1)
//  key - type (u8, 1)
//  padding (u8 x5, 5)
// the value is one aligned 8-byte word (payload and type together), so a racing reader
// can never see a new payload with an old type

// hash key for hashmap
export const __Porffor_object_hashMix = (hash: i32, word: i32): i32 => {
  hash += word * 3266489917;
  hash = (hash << 17) | (hash >>> 15);
  return hash * 668265263;
};

export const __Porffor_object_hashAvalanche = (hash: i32): i32 => {
  hash = (hash ^ (hash >>> 15)) * 2246822519;
  hash = (hash ^ (hash >>> 13)) * 3266489917;
  return hash ^ (hash >>> 16);
};

export const __Porffor_object_hash = (key: any): i32 => {
  if (Porffor.comptime.flag`hasType.symbol`) {
    if (Porffor.type(key) == Porffor.TYPES.symbol) {
      // symbol, hash is unused so just return 0
      return 0;
    }
  }

  // bytestring or string, xxh32-based hash
  let p: i32 = Porffor.IR.ptr(key);
  const len: i32 = Porffor.IR.loadI32(key, 0);
  let hash: i32 = 374761393;

  if (Porffor.type(key) == Porffor.TYPES.string) {
    const stringEnd: i32 = p + len * 2;
    let word: i32 = 0;
    let shift: i32 = 0;

    while (p < stringEnd) {
      const chr: i32 = Porffor.IR.loadU16(p, 4);
      p += 2;

      word |= (chr & 0xFF) << shift;
      shift += 8;
      if (shift == 32) {
        hash = __Porffor_object_hashMix(hash, word);
        word = 0;
        shift = 0;
      }

      const high: i32 = chr >> 8;
      if (high != 0) {
        word |= high << shift;
        shift += 8;
        if (shift == 32) {
          hash = __Porffor_object_hashMix(hash, word);
          word = 0;
          shift = 0;
        }
      }
    }

    if (shift != 0) hash = __Porffor_object_hashMix(hash, word);
    return __Porffor_object_hashAvalanche(hash);
  }

  const end: i32 = p + len;
  while (p + 4 <= end) {
    hash = __Porffor_object_hashMix(hash, Porffor.IR.loadI32(p, 4));
    p += 4;
  }

  if (p != end) {
    const mask: i32 = (1 << ((end - p) * 8)) - 1;
    hash = __Porffor_object_hashMix(hash, Porffor.IR.loadI32(p, 4) & mask);
  }

  return __Porffor_object_hashAvalanche(hash);
};

export const __Porffor_object_writeKey = (ptr: i32, key: any, hash: i32): void => {
  Porffor.IR.storeI32(ptr, 0, hash);

  Porffor.IR.storeI32(ptr, 4, key);
  Porffor.IR.storeU8(ptr, 18, Porffor.type(key));
};

export const __Porffor_object_new = (capacity: i32 = 4): object => {
  const obj: object = Porffor.malloc(24 + capacity * 24);
  const ptr: i32 = Porffor.IR.ptr(obj);
  Porffor.c`porf_obj_publish((u32)ptr, PORF_OBJ_SHAPE((u32)ptr + 24u, 0u, capacity));`;
  Porffor.IR.storeJv(obj, 8, undefined);
  Porffor.IR.storeU8(obj, 16, 0);
  // owned by this thread until another one writes it (see thread-local objects in render.js)
  Porffor.c`*(u32*)(MEM + (u32)ptr + 20u) = porf_self_tag();`;
  return obj;
};

export const __Porffor_object_entriesPtr = (obj: any): i32 => {
  return Porffor.IR.loadI32(obj, 0);
};

export const __Porffor_object_size = (obj: any): i32 => {
  return Porffor.IR.loadU16(obj, 4);
};

// grow so needed entries fit; caller holds the object lock
export const __Porffor_object_ensureCapacity = (obj: any, needed: i32): i32 => {
  const o: i32 = Porffor.IR.ptr(obj);
  let entriesPtr: i32 = 0;
  let size: i32 = 0;
  let capacity: i32 = 0;
  Porffor.c`PORF_OBJ_SNAP3(o, entriesPtr, size, capacity);`;
  if (needed <= capacity) return entriesPtr;

  if (capacity == 0) capacity = 1;
  while (capacity < needed) capacity *= 2;

  // copy, then publish: a reader still on the old block keeps a consistent view
  const newEntriesPtr: i32 = Porffor.malloc(capacity * 24);
  if (size > 0) {
    Porffor.IR.copy(newEntriesPtr, entriesPtr, size * 24);
  }

  Porffor.c`porf_obj_publish((u32)o, PORF_OBJ_SHAPE(newEntriesPtr, size, capacity));`;
  Porffor.IR.gcBarrier(obj, Porffor.TYPES.object);
  return newEntriesPtr;
};

// write flags and the value word (value, or the get/set pair when flags has the accessor
// bit) of the entry for key, adding it when entryPtr is 0. seen is the state the caller
// decided on: -1 no entry, -2 anything (an upsert), else the entry's flags.
// with threads readers never lock. the thread owning the object writes it without locking
// (see thread-local objects in render.js); any other writer holds the object lock and
// finds its entry again in the live block, since a grow or delete may have copied it away
// (a store to the old block would be lost). when the entry no longer matches seen it
// returns 1 and the caller starts over. an add publishes the size only once its entry is
// complete, and switching between value and accessor copies the block, as readers pair
// flags with word
export const __Porffor_object_commit = (obj: any, entryPtr: i32, key: any, hash: i32, seen: i32, flags: i32, value: any, get: any, set: any): i32 => {
  const o: i32 = Porffor.IR.ptr(obj);
  const getRaw: i32 = Porffor.IR.ptr(get);
  const setRaw: i32 = Porffor.IR.ptr(set);
  // threaded: readers on other threads may be walking the entries, so a structural change
  // copies them. shared: another thread may also be writing (not just this one, the
  // owner), so lock and find the entry again
  let threaded: i32 = 0;
  let shared: i32 = 0;
  Porffor.c`threaded = PORF_THREADED;
shared = !porf_ttl_mine((u32)o + 20u);
porf_obj_lock((u32)o);`;

  let entriesPtr: i32 = 0;
  let size: i32 = 0;
  let capacity: i32 = 0;
  Porffor.c`PORF_OBJ_SNAP3(o, entriesPtr, size, capacity);`;
  let copy: i32 = 0;
  let added: i32 = 0;
  if (shared) {
    let live: i32 = 0;
    if (entryPtr >= entriesPtr) if (entryPtr < entriesPtr + size * 24) if ((entryPtr - entriesPtr) % 24 == 0)
      if (Porffor.IR.loadI32(entryPtr, 0) == hash) if (Porffor.IR.loadI32(entryPtr, 4) == Porffor.IR.ptr(key))
        if (Porffor.IR.loadU8(entryPtr, 18) == Porffor.type(key)) live = 1;
    if (!live) entryPtr = __Porffor_object_lookup(obj, key, hash);

    if (seen != -2) {
      let stale: i32 = 0;
      if (entryPtr == 0) {
        stale = seen != -1;
        // an add decided on before preventExtensions
        if (seen == -1) if (Porffor.IR.loadU8(obj, 16) & 0b0001) stale = 1;
      } else {
        stale = Porffor.IR.loadU8(entryPtr, 16) != seen;
      }

      if (stale) {
        Porffor.c`porf_obj_unlock((u32)o);`;
        return 1;
      }
    }
  }
  if (threaded) if (entryPtr != 0) copy = (Porffor.IR.loadU8(entryPtr, 16) ^ flags) & 0b0001;

  if (entryPtr == 0) {
    entriesPtr = __Porffor_object_ensureCapacity(obj, size + 1);
    Porffor.c`capacity = (i32)(u16)(porf_obj_snap((u32)o) >> 48);`;
    entryPtr = entriesPtr + size * 24;
    __Porffor_object_writeKey(entryPtr, key, hash);
    size += 1;
    added = 1;
  } else if (copy) {
    const newEntriesPtr: i32 = Porffor.malloc(capacity * 24);
    Porffor.IR.copy(newEntriesPtr, entriesPtr, size * 24);
    entryPtr = newEntriesPtr + (entryPtr - entriesPtr);
    entriesPtr = newEntriesPtr;
  }

  Porffor.IR.storeU8(entryPtr, 16, flags);
  Porffor.c`porf_obj_store_word((u32)entryPtr + 8u, (flags & 1) ? ((u64)(u32)getRaw | ((u64)(u32)setRaw << 32)) : porf_pack(value));`;
  if (Porffor.fastOr(added, copy)) Porffor.c`porf_obj_publish((u32)o, PORF_OBJ_SHAPE(entriesPtr, size, capacity));`;
  Porffor.c`porf_obj_unlock((u32)o);`;

  if (added) Porffor.IR.gcBarrierValue(obj, Porffor.TYPES.object, key);
  if (copy) Porffor.IR.gcBarrier(obj, Porffor.TYPES.object);
  if (flags & 0b0001) {
    Porffor.IR.gcBarrierValue(obj, Porffor.TYPES.object, get);
    Porffor.IR.gcBarrierValue(obj, Porffor.TYPES.object, set);
  } else {
    Porffor.IR.gcBarrierValue(obj, Porffor.TYPES.object, value);
  }
  return 0;
};

// drop the entry for key (at entryPtr when the caller just looked it up). with threads a
// reader may be walking the entries right now, so build a new block and publish it
// instead of shifting entries in place
export const __Porffor_object_removeEntry = (obj: any, entryPtr: i32, key: any, hash: i32): void => {
  const o: i32 = Porffor.IR.ptr(obj);
  let threaded: i32 = 0;
  let shared: i32 = 0;
  Porffor.c`threaded = PORF_THREADED;
shared = !porf_ttl_mine((u32)o + 20u);
porf_obj_lock((u32)o);`;
  if (shared) {
    entryPtr = __Porffor_object_lookup(obj, key, hash);
    if (entryPtr == 0) {
      Porffor.c`porf_obj_unlock((u32)o);`;
      return;
    }
  }

  let entriesPtr: i32 = 0;
  let size: i32 = 0;
  let capacity: i32 = 0;
  Porffor.c`PORF_OBJ_SNAP3(o, entriesPtr, size, capacity);`;
  const ind: i32 = (entryPtr - entriesPtr) / 24;
  const after: i32 = size - ind - 1;

  if (threaded) {
    const newEntriesPtr: i32 = Porffor.malloc(capacity * 24);
    if (ind > 0) Porffor.IR.copy(newEntriesPtr, entriesPtr, ind * 24);
    if (after > 0) Porffor.IR.copy(newEntriesPtr + ind * 24, entryPtr + 24, after * 24);
    Porffor.c`porf_obj_publish((u32)o, PORF_OBJ_SHAPE(newEntriesPtr, size - 1, capacity));`;
    Porffor.IR.gcBarrier(obj, Porffor.TYPES.object);
  } else {
    if (after > 0) Porffor.IR.copy(entryPtr, entryPtr + 24, after * 24);
    Porffor.c`porf_obj_publish((u32)o, PORF_OBJ_SHAPE(entriesPtr, size - 1, capacity));`;
  }
  Porffor.c`porf_obj_unlock((u32)o);`;
};

export const __Porffor_object_fastAdd = (obj: any, key: any, value: any, flags: i32): void => {
  __Porffor_object_commit(obj, 0, key, __Porffor_object_hash(key), -2, flags, value, undefined, undefined);
};

export const __Porffor_object_readValue = (entryPtr: i32): any => {
  return Porffor.IR.loadJv(entryPtr, 8);
};

// store underlying (real) objects for hidden types
let underlyingStore: i32 = 0;
let underlyingBuckets: i32 = 0;
let underlyingBucketsCap: i32 = 0;

export const __Porffor_underlyingInsertEntry = (base: i32, index: i32): void => {
  let hash: i32 = Porffor.IR.ptr(Porffor.IR.loadJv(base, 0));
  hash = hash >>> 3;
  hash ^= hash >>> 16;
  hash *= 0x7feb352d;
  hash ^= hash >>> 15;
  hash ^= Porffor.IR.loadU8(base, 12);

  let slot: i32 = hash & (underlyingBucketsCap - 1);
  while (true) {
    if (Porffor.IR.loadI32(underlyingBuckets + slot * 4, 0) == 0) {
      Porffor.IR.storeI32(underlyingBuckets + slot * 4, 0, index + 1);
      return;
    }

    slot = (slot + 1) & (underlyingBucketsCap - 1);
  }
};

export const __Porffor_underlyingRebuild = (): void => {
  let len: i32 = Porffor.IR.loadI32(underlyingStore, 0);
  let cap: i32 = 16;
  while (cap * 3 < (len + 1) * 4) cap *= 2;

  underlyingBuckets = Porffor.malloc(cap * 4);
  Porffor.IR.fill(underlyingBuckets, 0, cap * 4);
  underlyingBucketsCap = cap;

  len = Porffor.IR.loadI32(underlyingStore, 0);

  for (let i: i32 = 0; i < len; i++) {
    __Porffor_underlyingInsertEntry(underlyingStore + 8 + i * 16, i);
  }
};

export const __Porffor_object_underlying = (_obj: any): any => {
  if (Porffor.type(_obj) == Porffor.TYPES.object) return _obj;

  // the underlying store is shared by every thread
  Porffor.c`porf_builtin_lock();`;
  const out: any = __Porffor_object_underlyingLocked(_obj);
  Porffor.c`porf_builtin_unlock();`;
  return out;
};

// caller holds the builtin lock
export const __Porffor_object_underlyingLocked = (_obj: any): any => {
  const objType: i32 = Porffor.type(_obj);
  if (objType == Porffor.TYPES.object) return _obj;

  if (objType > 0x05) {
    if (underlyingStore == 0) {
      underlyingStore = Porffor.malloc();
      Porffor.IR.storeI32(underlyingStore, 0, 0);
      Porffor.IR.storeI32(underlyingStore, 4, 1023);
    }

    let underlyingLength: i32 = Porffor.IR.loadI32(underlyingStore, 0);
    if (Porffor.fastAnd(underlyingBuckets == 0, underlyingLength > 0)) __Porffor_underlyingRebuild();

    if (underlyingBuckets != 0) {
      let lookupHash: i32 = Porffor.IR.ptr(_obj);
      lookupHash = lookupHash >>> 3;
      lookupHash ^= lookupHash >>> 16;
      lookupHash *= 0x7feb352d;
      lookupHash ^= lookupHash >>> 15;
      lookupHash ^= objType;

      let slot: i32 = lookupHash & (underlyingBucketsCap - 1);
      while (true) {
        const entry: i32 = Porffor.IR.loadI32(underlyingBuckets + slot * 4, 0);
        if (entry == 0) break;

        const base: i32 = underlyingStore + 8 + (entry - 1) * 16;
        if (Porffor.fastAnd(
          Porffor.IR.ptr(Porffor.IR.loadJv(base, 0)) == Porffor.IR.ptr(_obj),
          Porffor.IR.loadU8(base, 12) == objType
        ))
          return Porffor.IR.loadI32(base, 8) as object;

        slot = (slot + 1) & (underlyingBucketsCap - 1);
      }
    }

    // grow the weak store before allocating the underlying object: this malloc
    // could otherwise collect the not-yet-registered object
    const capacity: i32 = Porffor.IR.loadI32(underlyingStore, 4);
    if (underlyingLength >= capacity) {
      const newCapacity: i32 = capacity * 2;
      const newStore: i32 = Porffor.malloc(8 + newCapacity * 16);

      underlyingLength = Porffor.IR.loadI32(underlyingStore, 0);
      const copyBytes: i32 = 8 + underlyingLength * 16;
      for (let i: i32 = 0; i < copyBytes; i += 4) {
        Porffor.IR.storeI32(newStore + i, 0, Porffor.IR.loadI32(underlyingStore + i, 0));
      }

      underlyingStore = newStore;
      Porffor.IR.storeI32(underlyingStore, 4, newCapacity);
    }

    let obj: any = _obj;

    let underlyingCapacity: i32 = 4;
    if (Porffor.fastOr(
      objType == Porffor.TYPES.string,
      objType == Porffor.TYPES.stringobject
    )) {
      underlyingCapacity = (obj as string).length + 1;
      if (underlyingCapacity > 4097) underlyingCapacity = 4;
    } else if (objType == Porffor.TYPES.bytestring) {
      underlyingCapacity = (obj as bytestring).length + 1;
      if (underlyingCapacity > 4097) underlyingCapacity = 4;
    }

    const underlying: object = __Porffor_object_new(underlyingCapacity);

    // publish before initialization can allocate, so the GC's underlying-store scanner sees both
    underlyingLength = Porffor.IR.loadI32(underlyingStore, 0);
    Porffor.IR.storeI32(underlyingStore, 0, underlyingLength + 1);
    const base: i32 = underlyingStore + 8 + underlyingLength * 16;
    Porffor.IR.storeJv(base, 0, _obj);
    Porffor.IR.storeI32(base, 8, underlying);
    Porffor.IR.storeU8(base, 12, objType);

    if (objType == Porffor.TYPES.function) {
      __Porffor_object_fastAdd(underlying, 'length', __Porffor_funcLut_length(obj), 0b0010);
      __Porffor_object_fastAdd(underlying, 'name', __Porffor_funcLut_name(obj), 0b0010);

      if (ecma262.IsConstructor(_obj)) { // constructor
        const builtinProto: any = __Porffor_object_builtinPrototype(_obj);
        if (builtinProto !== undefined) {
          __Porffor_object_fastAdd(underlying, 'prototype', builtinProto, 0b0000);
        } else {
          const proto: object = __Porffor_object_new(1);
          __Porffor_object_fastAdd(underlying, 'prototype', proto, 0b1000);
          __Porffor_object_fastAdd(proto, 'constructor', _obj, 0b1010);
        }
      }
    }

    if (objType == Porffor.TYPES.array) {
      // index props are not materialized (the live array is the source of truth), only expando props and length live here
      const len: i32 = Porffor.IR.loadI32(obj, 0);
      __Porffor_object_fastAdd(underlying, 'length', len, 0b1000);
    }

    if (Porffor.fastOr(
      objType == Porffor.TYPES.string,
      objType == Porffor.TYPES.stringobject
    )) {
      const len: i32 = (obj as string).length;
      __Porffor_object_fastAdd(underlying, 'length', len, 0b0000);

      // size/capacity are u16: skip per-index props for huge strings
      const matLen: i32 = len > 4096 ? 0 : len;
      for (let i: i32 = 0; i < matLen; i++) {
        __Porffor_object_fastAdd(underlying, Porffor.callThis(__Number_prototype_toString, i), (obj as string)[i], 0b0100);
      }

      if (objType == Porffor.TYPES.string) {
        Porffor.IR.storeU8(underlying, 16, 0b0001);
      }
    }

    if (objType == Porffor.TYPES.bytestring) {
      const len: i32 = (obj as bytestring).length;
      __Porffor_object_fastAdd(underlying, 'length', len, 0b0000);

      const matLen: i32 = len > 4096 ? 0 : len;
      for (let i: i32 = 0; i < matLen; i++) {
        __Porffor_object_fastAdd(underlying, Porffor.callThis(__Number_prototype_toString, i), (obj as bytestring)[i], 0b0100);
      }

      Porffor.IR.storeU8(underlying, 16, 0b0001);
    }

    if (Porffor.fastOr(underlyingBuckets == 0, (underlyingLength + 2) * 4 > underlyingBucketsCap * 3)) {
      __Porffor_underlyingRebuild();
    } else {
      __Porffor_underlyingInsertEntry(base, underlyingLength);
    }

    return underlying;
  }

  return _obj;
};

export const __Porffor_object_isObject = (arg: any): boolean => {
  const t: i32 = Porffor.type(arg);
  return Porffor.fastAnd(
    arg !== null,
    t > 0x05,
    t != Porffor.TYPES.string,
    t != Porffor.TYPES.bytestring
  );
};

export const __Porffor_object_isObjectOrNull = (arg: any): boolean => {
  const t: i32 = Porffor.type(arg);
  return Porffor.fastAnd(
    t > 0x05,
    t != Porffor.TYPES.string,
    t != Porffor.TYPES.bytestring
  );
};

export const __Porffor_object_isObjectOrSymbol = (arg: any): boolean => {
  const t: i32 = Porffor.type(arg);
  return Porffor.fastAnd(
    arg !== null,
    t > 0x04,
    t != Porffor.TYPES.string,
    t != Porffor.TYPES.bytestring
  );
};


export const __Porffor_object_preventExtensions = (obj: any): void => {
  if (Porffor.type(obj) != Porffor.TYPES.object) {
    obj = __Porffor_object_underlying(obj);
    if (Porffor.type(obj) != Porffor.TYPES.object) return;
  }

  // under the lock so an add in flight (which checks under it) is either before or rejected
  const o: i32 = Porffor.IR.ptr(obj);
  Porffor.c`porf_obj_lock((u32)o);`;
  Porffor.IR.storeU8(obj, 16, Porffor.IR.loadU8(obj, 16) | 0b0001);
  Porffor.c`porf_obj_unlock((u32)o);`;
};

export const __Porffor_object_isInextensible = (obj: any): boolean => {
  if (Porffor.type(obj) != Porffor.TYPES.object) {
    obj = __Porffor_object_underlying(obj);
    if (Porffor.type(obj) != Porffor.TYPES.object) return false;
  }

  return (Porffor.IR.loadU8(obj, 16) & 0b0001) != 0;
};

export const __Porffor_object_setPrototype = (obj: any, proto: any): void => {
  if (Porffor.type(obj) != Porffor.TYPES.object) {
    obj = __Porffor_object_underlying(obj);
    if (Porffor.type(obj) != Porffor.TYPES.object) return;
  }

  if (__Porffor_object_isObjectOrNull(proto)) {
    Porffor.IR.storeJv(obj, 8, proto);
    Porffor.IR.gcBarrierValue(obj, Porffor.TYPES.object, proto);
  }
};

export const __Porffor_object_getPrototype = (obj: any): any => {
  if (Porffor.type(obj) != Porffor.TYPES.object) {
    obj = __Porffor_object_underlying(obj);
    if (Porffor.type(obj) != Porffor.TYPES.object) {
      return undefined;
    }
  }

  return Porffor.IR.loadJv(obj, 8);
};

export const __Porffor_object_getPrototypeWithHidden = (obj: any, trueType: i32): any => {
  const objectProto: any = __Porffor_object_getPrototype(obj);
  if (Porffor.type(objectProto) != Porffor.TYPES.undefined) return objectProto;

  return __Porffor_object_getHiddenPrototype(trueType);
};


export const __Porffor_object_overrideAllFlags = (obj: any, overrideOr: i32, overrideAnd: i32): void => {
  if (Porffor.type(obj) != Porffor.TYPES.object) {
    obj = __Porffor_object_underlying(obj);
    if (Porffor.type(obj) != Porffor.TYPES.object) return;
  }

  const o: i32 = Porffor.IR.ptr(obj);
  let ptr: i32 = 0;
  let size: i32 = 0;
  // under the lock: writers check the flags they decided on under it, and the block is live
  Porffor.c`porf_obj_lock((u32)o);`;
  Porffor.c`PORF_OBJ_SNAP(o, ptr, size);`;
  const endPtr: i32 = ptr + size * 24;

  for (; ptr < endPtr; ptr += 24) {
    let flags: i32 = Porffor.IR.loadU8(ptr, 16);
    flags = (flags | overrideOr) & overrideAnd;
    Porffor.IR.storeU8(ptr, 16, flags);
  }
  Porffor.c`porf_obj_unlock((u32)o);`;
};

export const __Porffor_object_checkAllFlags = (obj: any, dataAnd: i32, accessorAnd: i32, dataExpected: i32, accessorExpected: i32): boolean => {
  if (Porffor.type(obj) != Porffor.TYPES.object) {
    obj = __Porffor_object_underlying(obj);
    if (Porffor.type(obj) != Porffor.TYPES.object) return false;
  }

  const o: i32 = Porffor.IR.ptr(obj);
  let ptr: i32 = 0;
  let size: i32 = 0;
  Porffor.c`PORF_OBJ_SNAP(o, ptr, size);`;
  const endPtr: i32 = ptr + size * 24;

  for (; ptr < endPtr; ptr += 24) {
    const flags: i32 = Porffor.IR.loadU8(ptr, 16);
    if (flags & 0b0001) {
      // accessor
      if ((flags & accessorAnd) != accessorExpected) return false;
    } else {
      // data
      if ((flags & dataAnd) != dataExpected) return false;
    }

  }

  return true;
};

// the pair is one word written at once (porf_obj_store_word): read it whole, ordered like a
// value word, as the function it points at may have just been made on another thread
export const __Porffor_object_accessorGet = (entryPtr: i32): Function|undefined => {
  let fnPtr: i32 = 0;
  Porffor.c`fnPtr = (i32)(u32)porf_ld_bits(MEM + (u32)entryPtr + 8u);`;
  const out: Function = fnPtr;

  if (Porffor.IR.ptr(out) == 0) return undefined;
  return out;
};

export const __Porffor_object_accessorSet = (entryPtr: i32): Function|undefined => {
  let fnPtr: i32 = 0;
  Porffor.c`fnPtr = (i32)(u32)(porf_ld_bits(MEM + (u32)entryPtr + 8u) >> 32);`;
  const out: Function = fnPtr;

  if (Porffor.IR.ptr(out) == 0) return undefined;
  return out;
};

export const __Porffor_object_lookup = (obj: any, target: any, targetHash: i32): i32 => {
  if (Porffor.IR.ptr(obj) == 0) return 0;

  const o: i32 = Porffor.IR.ptr(obj);
  let ptr: i32 = 0;
  let size: i32 = 0;
  Porffor.c`PORF_OBJ_SNAP(o, ptr, size);`;
  const endPtr: i32 = ptr + size * 24;

  if (Porffor.comptime.flag`hasType.symbol`) {
    if (Porffor.type(target) == Porffor.TYPES.symbol) {
      for (; ptr < endPtr; ptr += 24) {
        const key: i32 = Porffor.IR.loadI32(ptr, 4);
        if (Porffor.IR.loadU8(ptr, 18) == Porffor.TYPES.symbol) {
          // todo: remove casts once weird bug which breaks unrelated things is fixed (https://github.com/CanadaHonk/porffor/commit/5747f0c1f3a4af95283ebef175cdacb21e332a52)
          if (key as symbol == target as symbol) return ptr;
        }
      }

      return 0;
    }
  }

  for (; ptr < endPtr; ptr += 24) {
    if (Porffor.IR.loadI32(ptr, 0) == targetHash) {
      return ptr;
    }
  }

  return 0;
};

export const __Porffor_array_propertyKeyIndex = (key: any): i32 => {
  const keyType: i32 = Porffor.type(key);
  if (Porffor.fastAnd(keyType != Porffor.TYPES.string, keyType != Porffor.TYPES.bytestring)) return -1;

  const len: i32 = key.length;
  if (len == 0) return -1;

  let digit: i32 = key.charCodeAt(0) - 48;
  if (Porffor.fastOr(digit < 0, digit > 9)) return -1;
  if (Porffor.fastAnd(len > 1, digit == 0)) return -1;

  let out: i32 = digit;
  for (let i: i32 = 1; i < len; i++) {
    digit = key.charCodeAt(i) - 48;
    if (Porffor.fastOr(digit < 0, digit > 9)) return -1;
    if (Porffor.fastOr(out > 214748364, Porffor.fastAnd(out == 214748364, digit > 6))) return -1;

    out = out * 10 + digit;
  }

  return out;
};

export const __Porffor_object_get = (_obj: any, key: any): any => {
  let obj: any = _obj;
  const trueType: i32 = Porffor.type(obj);
  if (trueType == Porffor.TYPES.object) {
    if (Porffor.IR.ptr(obj) == 0) throw new TypeError('Cannot get property of null');
  } else {
    if (trueType == Porffor.TYPES.undefined) throw new TypeError('Cannot get property of null');
    obj = __Porffor_object_underlying(obj);
  }

  key = ecma262.ToPropertyKey(key);
  if (trueType == Porffor.TYPES.array) {
    const index: i32 = __Porffor_array_propertyKeyIndex(key);
    if (index != -1) {
      if (__Porffor_array_has(_obj as any[], index)) return (_obj as any[])[index];
    }
  }

  const hash: i32 = __Porffor_object_hash(key);
  let entryPtr: i32 = 0;
  if (Porffor.type(obj) == Porffor.TYPES.object) entryPtr = __Porffor_object_lookup(obj, key, hash);
  if (entryPtr == 0) {
    // check prototype chain
    if (trueType == Porffor.TYPES.object) {
      obj = __Porffor_object_getPrototype(obj);
      // if undefined, prototype is object.prototype
      if (Porffor.type(obj) == Porffor.TYPES.undefined) obj = __Object_prototype;
    } else obj = __Porffor_object_getPrototypeWithHidden(obj, trueType);

    // todo/opt: put this behind comptime flag if only __proto__ is used
    if (hash == 212292208) if (Porffor.strcmp(key, '__proto__')) {
      // get prototype
      return obj;
    }

    let proto: any = obj;
    if (Porffor.type(obj) != Porffor.TYPES.object) obj = __Porffor_object_underlying(obj);
    if (obj == null) return undefined;
    while (true) {
      if ((entryPtr = __Porffor_object_lookup(obj, key, hash)) != 0) break;

      // inline get prototype
      obj = __Porffor_object_getPrototype(obj);
      if (Porffor.type(obj) == Porffor.TYPES.undefined) {
        obj = __Porffor_object_getHiddenPrototype(Porffor.type(proto));
        if (Porffor.IR.ptr(obj) == Porffor.IR.ptr(proto)) obj = __Object_prototype;
      }
      if (Porffor.IR.ptr(obj) == Porffor.IR.ptr(proto)) break;

      proto = obj;
      if (Porffor.type(obj) != Porffor.TYPES.object) obj = __Porffor_object_underlying(obj);
      if (obj == null) break;
    }

    if (entryPtr == 0) return undefined;
  }

  const tail: i32 = Porffor.IR.loadU16(entryPtr, 16);
  if (tail & 0b0001) {
    // accessor descriptor
    const get: Function = __Porffor_object_accessorGet(entryPtr);

    if (Porffor.IR.ptr(get) == 0) return undefined;
    return Porffor.callThis(get, _obj);
  }

  return __Porffor_object_readValue(entryPtr);
};

// per-call-site slot cache stores byte offsets into object entries
// IC_EMPTY is i32 max so unset and stale slots fail the bounds/hash checks
export const __Porffor_object_get_ic = (_obj: any, key: any, hash: i32, slot: i32): any => {
  if (Porffor.type(_obj) == Porffor.TYPES.object) {
    if (Porffor.IR.ptr(_obj) != 0) {
      // the site's cache, shared by every thread: a stale offset just fails the hash check
      let off: i32 = 0;
      Porffor.c`off = PORF_LD_RLX((i32*)(MEM + (u32)slot));`;
      const o: i32 = Porffor.IR.ptr(_obj);
      let entriesPtr: i32 = 0;
      let size: i32 = 0;
      Porffor.c`PORF_OBJ_SNAP(o, entriesPtr, size);`;
      if (off < size * 24) {
        const entryPtr: i32 = entriesPtr + off;
        if (Porffor.IR.loadI32(entryPtr, 0) == hash) {
          if ((Porffor.IR.loadU16(entryPtr, 16) & 0b0001) == 0) return __Porffor_object_readValue(entryPtr);
        }
      }
    }
  }

  return __Porffor_object_get_icMiss(_obj, key, hash, slot);
};

export const __Porffor_object_get_icMiss = (_obj: any, key: any, hash: i32, slot: i32): any => {
  if (Porffor.type(_obj) == Porffor.TYPES.object) {
    if (Porffor.IR.ptr(_obj) != 0) {
      const o: i32 = Porffor.IR.ptr(_obj);
      let entriesPtr: i32 = 0;
      let size: i32 = 0;
      Porffor.c`PORF_OBJ_SNAP(o, entriesPtr, size);`;
      let ptr: i32 = entriesPtr;
      const endPtr: i32 = ptr + size * 24;
      for (; ptr < endPtr; ptr += 24) {
        if (Porffor.IR.loadI32(ptr, 0) == hash) {
          // first writer wins so polymorphic sites miss instead of storing each time
          Porffor.c`{ i32 porf_ic_free_ = 2147483647; __atomic_compare_exchange_n((i32*)(MEM + (u32)slot), &porf_ic_free_, (i32)(ptr - entriesPtr), 0, __ATOMIC_RELAXED, __ATOMIC_RELAXED); }`;
          if ((Porffor.IR.loadU16(ptr, 16) & 0b0001) == 0) return __Porffor_object_readValue(ptr);
          break;
        }
      }
    }
  }

  return __Porffor_object_get_withHash(_obj, key, hash);
};

// a write IC miss (see porf_ic_set in render.js): the ordinary set, then the site's slot for
// the entry when it is an own writable data property. first writer wins, as for reads
export const __Porffor_object_set_icMiss = (obj: any, key: any, value: any, hash: i32, slot: i32): any => {
  __Porffor_object_set_withHash(obj, key, value, hash);
  __Porffor_object_icFillWrite(obj, hash, slot);
  return value;
};

export const __Porffor_object_setStrict_icMiss = (obj: any, key: any, value: any, hash: i32, slot: i32): any => {
  __Porffor_object_setStrict_withHash(obj, key, value, hash);
  __Porffor_object_icFillWrite(obj, hash, slot);
  return value;
};

export const __Porffor_object_icFillWrite = (obj: any, hash: i32, slot: i32): void => {
  if (Porffor.type(obj) != Porffor.TYPES.object) return;
  const o: i32 = Porffor.IR.ptr(obj);
  if (o == 0) return;
  let entriesPtr: i32 = 0;
  let size: i32 = 0;
  Porffor.c`PORF_OBJ_SNAP(o, entriesPtr, size);`;
  let ptr: i32 = entriesPtr;
  const endPtr: i32 = ptr + size * 24;
  for (; ptr < endPtr; ptr += 24) {
    if (Porffor.IR.loadI32(ptr, 0) == hash) {
      if ((Porffor.IR.loadU8(ptr, 16) & 0b1001) == 0b1000) Porffor.c`{ i32 porf_ic_free_ = 2147483647; __atomic_compare_exchange_n((i32*)(MEM + (u32)slot), &porf_ic_free_, (i32)(ptr - entriesPtr), 0, __ATOMIC_RELAXED, __ATOMIC_RELAXED); }`;
      return;
    }
  }
};

export const __Porffor_object_get_withHash = (_obj: any, key: any, hash: i32): any => {
  let obj: any = _obj;
  const trueType: i32 = Porffor.type(obj);
  if (trueType == Porffor.TYPES.object) {
    if (Porffor.IR.ptr(obj) == 0) throw new TypeError('Cannot get property of null');
  } else {
    if (trueType == Porffor.TYPES.undefined) throw new TypeError('Cannot get property of null');
    obj = __Porffor_object_underlying(obj);
  }

  let entryPtr: i32 = 0;
  if (Porffor.type(obj) == Porffor.TYPES.object) entryPtr = __Porffor_object_lookup(obj, key, hash);
  if (entryPtr == 0) {
    // check prototype chain
    if (trueType == Porffor.TYPES.object) {
      obj = __Porffor_object_getPrototype(obj);
      // if undefined, prototype is object.prototype
      if (Porffor.type(obj) == Porffor.TYPES.undefined) obj = __Object_prototype;
    } else obj = __Porffor_object_getPrototypeWithHidden(obj, trueType);

    let proto: any = obj;
    if (Porffor.type(obj) != Porffor.TYPES.object) obj = __Porffor_object_underlying(obj);
    if (obj == null) return undefined;
    while (true) {
      if ((entryPtr = __Porffor_object_lookup(obj, key, hash)) != 0) break;

      // inline get prototype
      obj = __Porffor_object_getPrototype(obj);
      if (Porffor.type(obj) == Porffor.TYPES.undefined) {
        obj = __Porffor_object_getHiddenPrototype(Porffor.type(proto));
        if (Porffor.IR.ptr(obj) == Porffor.IR.ptr(proto)) obj = __Object_prototype;
      }
      if (Porffor.IR.ptr(obj) == Porffor.IR.ptr(proto)) break;

      proto = obj;
      if (Porffor.type(obj) != Porffor.TYPES.object) obj = __Porffor_object_underlying(obj);
      if (obj == null) break;
    }

    if (entryPtr == 0) return undefined;
  }

  const tail: i32 = Porffor.IR.loadU16(entryPtr, 16);
  if (tail & 0b0001) {
    // accessor descriptor
    const get: Function = __Porffor_object_accessorGet(entryPtr);

    if (Porffor.IR.ptr(get) == 0) return undefined;
    return Porffor.callThis(get, _obj);
  }

  return __Porffor_object_readValue(entryPtr);
};

// a set that is not to an existing entry of an object this thread owns, out of line to
// keep the common one small: an add (see __Porffor_object_commit), or a write to another
// thread's object, tried first inline under the lock (porf_obj_store_live). 1: start over
export const __Porffor_object_setOther = (obj: any, entryPtr: i32, key: any, hash: i32, value: any, flags: i32): i32 => {
  if (entryPtr != 0) {
    const objRaw: i32 = Porffor.IR.ptr(obj);
    const keyRaw: i32 = Porffor.IR.ptr(key);
    const keyType: i32 = Porffor.type(key);
    let stored: i32 = 0;
    Porffor.c`stored = porf_obj_store_live((u32)objRaw, (u32)entryPtr, (u32)hash, (u32)keyRaw, (u32)keyType, (u32)flags, porf_pack(value));`;
    if (stored) {
      Porffor.IR.gcBarrierValue(obj, Porffor.TYPES.object, value);
      return 0;
    }
  }

  return __Porffor_object_commit(obj, entryPtr, key, hash, entryPtr == 0 ? -1 : flags, flags, value, undefined, undefined);
};

export const __Porffor_object_set = (_obj: any, key: any, value: any): any => {
  let obj: any = _obj;
  const trueType: i32 = Porffor.type(obj);
  if (Porffor.type(obj) != Porffor.TYPES.object) {
    obj = __Porffor_object_underlying(obj);
    if (Porffor.type(obj) != Porffor.TYPES.object) return value;
  }

  if (Porffor.IR.ptr(obj) == 0) throw new TypeError('Cannot set property of null');

  key = ecma262.ToPropertyKey(key);
  const hash: i32 = __Porffor_object_hash(key);
  if (trueType == Porffor.TYPES.array) {
    const arrIndex: i32 = __Porffor_array_propertyKeyIndex(key);
    if (Porffor.fastAnd(arrIndex != -1, __Porffor_object_lookup(obj, key, hash) == 0)) {
      // grows, stores the element, then raises the length (under the array's lock)
      const arr: i32 = Porffor.IR.ptr(_obj);
      Porffor.c`porf_arr_set((u32)arr, (u32)arrIndex, value);`;
      return value;
    }
  }

  if (trueType == Porffor.TYPES.regexp) if (hash == -1322609992) if (Porffor.strcmp(key, 'lastIndex')) {
    Porffor.IR.storeI32(_obj, 8, ecma262.ToIntegerOrInfinity(value));
    return value;
  }

  let entryPtr: i32 = __Porffor_object_lookup(obj, key, hash);
  let flags: i32;
  if (entryPtr == 0) {
    if (hash == 212292208) if (Porffor.strcmp(key, '__proto__')) {
      // set prototype
      __Porffor_object_setPrototype(obj, value);
      return value;
    }

    // todo/opt: skip if no setters used
    // check prototype chain for setter
    let proto: any = __Porffor_object_getPrototype(obj);
    if (proto != null) {
      if (Porffor.type(proto) != Porffor.TYPES.object) proto = __Porffor_object_underlying(proto);
      let lastProto: any = proto;
      while (true) {
        if ((entryPtr = __Porffor_object_lookup(proto, key, hash)) != 0) break;

        proto = __Porffor_object_getPrototype(proto);
        if (Porffor.type(proto) != Porffor.TYPES.object) proto = __Porffor_object_underlying(proto);
        if (Porffor.fastOr(proto == null, Porffor.IR.ptr(proto) == Porffor.IR.ptr(lastProto))) break;
        lastProto = proto;
      }

      if (entryPtr != 0) {
        // found possible setter
        const tail: i32 = Porffor.IR.loadU16(entryPtr, 16);
        if (tail & 0b0001) {
          // accessor descriptor
          const set: Function = __Porffor_object_accessorSet(entryPtr);
          if (Porffor.IR.ptr(set) == 0) return value;

          Porffor.callThis(set, _obj, value);
          return value;
        }
      }
    }

    // add new entry
    // check if object is inextensible
    if (__Porffor_object_isInextensible(obj)) {
      return value;
    }

    entryPtr = 0;

    // flags = writable, enumerable, configurable, not accessor
    flags = 0b1110;
  } else {
    // existing entry, modify it
    const tail: i32 = Porffor.IR.loadU16(entryPtr, 16);

    if (tail & 0b0001) {
      // accessor descriptor
      const set: Function = __Porffor_object_accessorSet(entryPtr);
      if (Porffor.IR.ptr(set) == 0) return value;

      Porffor.callThis(set, _obj, value);
      return value;
    }

    // data descriptor
    if (!(tail & 0b1000)) {
      // not writable, return now
      return value;
    }

    // flags = same flags as before
    flags = tail & 0xff;
  }

  // an existing entry of an object this thread owns (always, without threads): nothing
  // else can move it, so write it in place. else out of line (an add, or another thread's)
  if (entryPtr != 0) {
    const objRaw: i32 = Porffor.IR.ptr(obj);
    let mine: i32 = 0;
    Porffor.c`mine = porf_ttl_mine((u32)objRaw + 20u);`;
    if (mine) {
      Porffor.IR.storeU8(entryPtr, 16, flags);
      Porffor.IR.storeJv(entryPtr, 8, value);
      Porffor.IR.gcBarrierValue(obj, Porffor.TYPES.object, value);
      return value;
    }
  }

  if (__Porffor_object_setOther(obj, entryPtr, key, hash, value, flags)) return __Porffor_object_set(_obj, key, value);
  return value;
};

export const __Porffor_object_set_withHash = (_obj: any, key: any, value: any, hash: i32): any => {
  let obj: any = _obj;
  const trueType: i32 = Porffor.type(obj);
  if (Porffor.type(obj) != Porffor.TYPES.object) {
    obj = __Porffor_object_underlying(obj);
    if (Porffor.type(obj) != Porffor.TYPES.object) return value;
  }

  if (Porffor.IR.ptr(obj) == 0) throw new TypeError('Cannot set property of null');

  if (trueType == Porffor.TYPES.regexp) if (hash == -1322609992) if (Porffor.strcmp(key, 'lastIndex')) {
    Porffor.IR.storeI32(_obj, 8, ecma262.ToIntegerOrInfinity(value));
    return value;
  }

  let entryPtr: i32 = __Porffor_object_lookup(obj, key, hash);
  let flags: i32;
  if (entryPtr == 0) {
    // todo/opt: skip if no setters used
    // check prototype chain for setter
    let proto: any = __Porffor_object_getPrototype(obj);
    if (proto != null) {
      if (Porffor.type(proto) != Porffor.TYPES.object) proto = __Porffor_object_underlying(proto);
      let lastProto: any = proto;
      while (true) {
        if ((entryPtr = __Porffor_object_lookup(proto, key, hash)) != 0) break;

        proto = __Porffor_object_getPrototype(proto);
        if (Porffor.type(proto) != Porffor.TYPES.object) proto = __Porffor_object_underlying(proto);
        if (Porffor.fastOr(proto == null, Porffor.IR.ptr(proto) == Porffor.IR.ptr(lastProto))) break;
        lastProto = proto;
      }

      if (entryPtr != 0) {
        // found possible setter
        const tail: i32 = Porffor.IR.loadU16(entryPtr, 16);
        if (tail & 0b0001) {
          // accessor descriptor
          const set: Function = __Porffor_object_accessorSet(entryPtr);
          if (Porffor.IR.ptr(set) == 0) return value;

          Porffor.callThis(set, _obj, value);
          return value;
        }
      }
    }

    // add new entry
    // check if object is inextensible
    if (__Porffor_object_isInextensible(obj)) {
      return value;
    }

    entryPtr = 0;

    // flags = writable, enumerable, configurable, not accessor
    flags = 0b1110;
  } else {
    // existing entry, modify it
    const tail: i32 = Porffor.IR.loadU16(entryPtr, 16);

    if (tail & 0b0001) {
      // accessor descriptor
      const set: Function = __Porffor_object_accessorSet(entryPtr);
      if (Porffor.IR.ptr(set) == 0) return value;

      Porffor.callThis(set, _obj, value);
      return value;
    }

    // data descriptor
    if (!(tail & 0b1000)) {
      // not writable, return now
      return value;
    }

    // flags = same flags as before
    flags = tail & 0xff;
  }

  // an existing entry of an object this thread owns (always, without threads): nothing
  // else can move it, so write it in place. else out of line (an add, or another thread's)
  if (entryPtr != 0) {
    const objRaw: i32 = Porffor.IR.ptr(obj);
    let mine: i32 = 0;
    Porffor.c`mine = porf_ttl_mine((u32)objRaw + 20u);`;
    if (mine) {
      Porffor.IR.storeU8(entryPtr, 16, flags);
      Porffor.IR.storeJv(entryPtr, 8, value);
      Porffor.IR.gcBarrierValue(obj, Porffor.TYPES.object, value);
      return value;
    }
  }

  if (__Porffor_object_setOther(obj, entryPtr, key, hash, value, flags)) return __Porffor_object_set_withHash(_obj, key, value, hash);
  return value;
};

export const __Porffor_object_setStrict = (_obj: any, key: any, value: any): any => {
  let obj: any = _obj;
  const trueType: i32 = Porffor.type(obj);
  if (Porffor.type(obj) != Porffor.TYPES.object) {
    obj = __Porffor_object_underlying(obj);
    if (Porffor.type(obj) != Porffor.TYPES.object) return value;
  }

  if (Porffor.IR.ptr(obj) == 0) throw new TypeError('Cannot set property of null');

  key = ecma262.ToPropertyKey(key);
  const hash: i32 = __Porffor_object_hash(key);
  if (trueType == Porffor.TYPES.array) {
    const arrIndex: i32 = __Porffor_array_propertyKeyIndex(key);
    if (Porffor.fastAnd(arrIndex != -1, __Porffor_object_lookup(obj, key, hash) == 0)) {
      // grows, stores the element, then raises the length (under the array's lock)
      const arr: i32 = Porffor.IR.ptr(_obj);
      Porffor.c`porf_arr_set((u32)arr, (u32)arrIndex, value);`;
      return value;
    }
  }

  if (trueType == Porffor.TYPES.regexp) if (hash == -1322609992) if (Porffor.strcmp(key, 'lastIndex')) {
    Porffor.IR.storeI32(_obj, 8, ecma262.ToIntegerOrInfinity(value));
    return value;
  }

  let entryPtr: i32 = __Porffor_object_lookup(obj, key, hash);
  let flags: i32;
  if (entryPtr == 0) {
    if (hash == 212292208) if (Porffor.strcmp(key, '__proto__')) {
      // set prototype
      __Porffor_object_setPrototype(obj, value);
      return value;
    }

    // todo/opt: skip if no setters used
    // check prototype chain for setter
    let proto: any = __Porffor_object_getPrototype(obj);
    if (proto != null) {
      if (Porffor.type(proto) != Porffor.TYPES.object) proto = __Porffor_object_underlying(proto);

      let lastProto: any = proto;
      while (true) {
        if ((entryPtr = __Porffor_object_lookup(proto, key, hash)) != 0) break;

        proto = __Porffor_object_getPrototype(proto);
        if (Porffor.type(proto) != Porffor.TYPES.object) proto = __Porffor_object_underlying(proto);
        if (Porffor.fastOr(proto == null, Porffor.IR.ptr(proto) == Porffor.IR.ptr(lastProto))) break;
        lastProto = proto;
      }

      if (entryPtr != 0) {
        // found possible setter
        const tail: i32 = Porffor.IR.loadU16(entryPtr, 16);
        if (tail & 0b0001) {
          // accessor descriptor
          const set: Function = __Porffor_object_accessorSet(entryPtr);
          if (Porffor.IR.ptr(set) == 0) throw new TypeError('Cannot set property with only getter');

          Porffor.callThis(set, _obj, value);
          return value;
        }
      }
    }

    // add new entry
    // check if object is inextensible
    if (__Porffor_object_isInextensible(obj)) {
      throw new TypeError('Cannot add property to inextensible object');
    }

    entryPtr = 0;

    // flags = writable, enumerable, configurable, not accessor
    flags = 0b1110;
  } else {
    // existing entry, modify it
    const tail: i32 = Porffor.IR.loadU16(entryPtr, 16);

    if (tail & 0b0001) {
      // accessor descriptor
      const set: Function = __Porffor_object_accessorSet(entryPtr);
      if (Porffor.IR.ptr(set) == 0) throw new TypeError('Cannot set property with only getter');

      Porffor.callThis(set, _obj, value);
      return value;
    }

    // data descriptor
    if (!(tail & 0b1000)) {
      // not writable, return now
      throw new TypeError('Cannot modify read-only property of object');
    }

    // flags = same flags as before
    flags = tail & 0xff;
  }

  // an existing entry of an object this thread owns (always, without threads): nothing
  // else can move it, so write it in place. else out of line (an add, or another thread's)
  if (entryPtr != 0) {
    const objRaw: i32 = Porffor.IR.ptr(obj);
    let mine: i32 = 0;
    Porffor.c`mine = porf_ttl_mine((u32)objRaw + 20u);`;
    if (mine) {
      Porffor.IR.storeU8(entryPtr, 16, flags);
      Porffor.IR.storeJv(entryPtr, 8, value);
      Porffor.IR.gcBarrierValue(obj, Porffor.TYPES.object, value);
      return value;
    }
  }

  if (__Porffor_object_setOther(obj, entryPtr, key, hash, value, flags)) return __Porffor_object_setStrict(_obj, key, value);
  return value;
};

export const __Porffor_object_setStrict_withHash = (_obj: any, key: any, value: any, hash: i32): any => {
  let obj: any = _obj;
  const trueType: i32 = Porffor.type(obj);
  if (Porffor.type(obj) != Porffor.TYPES.object) {
    obj = __Porffor_object_underlying(obj);
    if (Porffor.type(obj) != Porffor.TYPES.object) return value;
  }

  if (Porffor.IR.ptr(obj) == 0) throw new TypeError('Cannot set property of null');

  if (trueType == Porffor.TYPES.regexp) if (hash == -1322609992) if (Porffor.strcmp(key, 'lastIndex')) {
    Porffor.IR.storeI32(_obj, 8, ecma262.ToIntegerOrInfinity(value));
    return value;
  }

  let entryPtr: i32 = __Porffor_object_lookup(obj, key, hash);
  let flags: i32;
  if (entryPtr == 0) {
    // todo/opt: skip if no setters used
    // check prototype chain for setter
    let proto: any = __Porffor_object_getPrototype(obj);
    if (proto != null) {
      if (Porffor.type(proto) != Porffor.TYPES.object) proto = __Porffor_object_underlying(proto);

      let lastProto: any = proto;
      while (true) {
        if ((entryPtr = __Porffor_object_lookup(proto, key, hash)) != 0) break;

        proto = __Porffor_object_getPrototype(proto);
        if (Porffor.type(proto) != Porffor.TYPES.object) proto = __Porffor_object_underlying(proto);
        if (Porffor.fastOr(proto == null, Porffor.IR.ptr(proto) == Porffor.IR.ptr(lastProto))) break;
        lastProto = proto;
      }

      if (entryPtr != 0) {
        // found possible setter
        const tail: i32 = Porffor.IR.loadU16(entryPtr, 16);
        if (tail & 0b0001) {
          // accessor descriptor
          const set: Function = __Porffor_object_accessorSet(entryPtr);
          if (Porffor.IR.ptr(set) == 0) throw new TypeError('Cannot set property with only getter');

          Porffor.callThis(set, _obj, value);
          return value;
        }
      }
    }

    // add new entry
    // check if object is inextensible
    if (__Porffor_object_isInextensible(obj)) {
      throw new TypeError('Cannot add property to inextensible object');
    }

    entryPtr = 0;

    // flags = writable, enumerable, configurable, not accessor
    flags = 0b1110;
  } else {
    // existing entry, modify it
    const tail: i32 = Porffor.IR.loadU16(entryPtr, 16);

    if (tail & 0b0001) {
      // accessor descriptor
      const set: Function = __Porffor_object_accessorSet(entryPtr);
      if (Porffor.IR.ptr(set) == 0) throw new TypeError('Cannot set property with only getter');

      Porffor.callThis(set, _obj, value);
      return value;
    }

    // data descriptor
    if (!(tail & 0b1000)) {
      // not writable, return now
      throw new TypeError('Cannot modify read-only property of object');
    }

    // flags = same flags as before
    flags = tail & 0xff;
  }

  // an existing entry of an object this thread owns (always, without threads): nothing
  // else can move it, so write it in place. else out of line (an add, or another thread's)
  if (entryPtr != 0) {
    const objRaw: i32 = Porffor.IR.ptr(obj);
    let mine: i32 = 0;
    Porffor.c`mine = porf_ttl_mine((u32)objRaw + 20u);`;
    if (mine) {
      Porffor.IR.storeU8(entryPtr, 16, flags);
      Porffor.IR.storeJv(entryPtr, 8, value);
      Porffor.IR.gcBarrierValue(obj, Porffor.TYPES.object, value);
      return value;
    }
  }

  if (__Porffor_object_setOther(obj, entryPtr, key, hash, value, flags)) return __Porffor_object_setStrict_withHash(_obj, key, value, hash);
  return value;
};

export const __Porffor_object_define = (obj: any, key: any, value: any, flags: i32): void => {
  if (Porffor.type(obj) != Porffor.TYPES.object) {
    obj = __Porffor_object_underlying(obj);
    if (Porffor.type(obj) != Porffor.TYPES.object) return;
  }

  const hash: i32 = __Porffor_object_hash(key);
  let entryPtr: i32 = __Porffor_object_lookup(obj, key, hash);
  let seen: i32 = -1;
  if (entryPtr == 0) {
    // add new entry
    // check if object is inextensible
    if (__Porffor_object_isInextensible(obj)) {
      throw new TypeError('Cannot define property, object is inextensible');
    }
  } else {
    // existing entry, check and maybe modify it
    const tail: i32 = Porffor.IR.loadU16(entryPtr, 16);
    seen = tail & 0xff;

    if ((tail & 0b0010) == 0) {
      // not already configurable, check to see if we can redefine
      let err: boolean = false;

      // descriptor type (accessor/data) and/or flags (other than writable) have changed
      if ((tail & 0b0111) != (flags & 0b0111)) {
        err = true;
      } else if ((tail & 0b1000) == 0) {
        // already non-writable only checks
        // trying to change writable false -> true
        if (flags & 0b1000) {
          err = true;
        } else {
          // if already non-writable, check value isn't being changed
          err = !__Object_is(__Porffor_object_readValue(entryPtr), value);
        }
      }

      if (err) throw new TypeError('Cannot redefine property');
    }
  }

  if (__Porffor_object_commit(obj, entryPtr, key, hash, seen, flags, value, undefined, undefined)) __Porffor_object_define(obj, key, value, flags);
};

export const __Porffor_object_defineAccessor = (obj: any, key: any, get: any, set: any, flags: i32): void => {
  if (Porffor.type(obj) != Porffor.TYPES.object) {
    obj = __Porffor_object_underlying(obj);
    if (Porffor.type(obj) != Porffor.TYPES.object) return;
  }

  const hash: i32 = __Porffor_object_hash(key);
  let entryPtr: i32 = __Porffor_object_lookup(obj, key, hash);
  let seen: i32 = -1;
  const getRaw: i32 = Porffor.IR.ptr(get);
  const setRaw: i32 = Porffor.IR.ptr(set);

  if (entryPtr == 0) {
    // add new entry
    // check if object is inextensible
    if (__Porffor_object_isInextensible(obj)) {
      throw new TypeError('Cannot define property, object is inextensible');
    }
  } else {
    // existing entry, check and maybe modify it
    const tail: i32 = Porffor.IR.loadU16(entryPtr, 16);
    seen = tail & 0xff;

    if ((tail & 0b0010) == 0) {
      // not already configurable, check to see if we can redefine
      let err: boolean = false;

      // descriptor type (accessor/data) and/or flags (other than writable) have changed
      if ((tail & 0b0111) != (flags & 0b0111)) {
        err = true;
      } else if ((tail & 0b1000) == 0) {
        // trying to change writable false -> true
        if (flags & 0b1000) err = true;
        if (Porffor.IR.loadI32(entryPtr, 8) != getRaw) err = true;
        if (Porffor.IR.loadI32(entryPtr, 12) != setRaw) err = true;
      }

      if (err) throw new TypeError('Cannot redefine property');
    }
  }

  if (__Porffor_object_commit(obj, entryPtr, key, hash, seen, flags, undefined, get, set)) __Porffor_object_defineAccessor(obj, key, get, set, flags);
};

export const __Porffor_object_delete = (obj: any, key: any): boolean => {
  if (Porffor.IR.ptr(obj) == 0) throw new TypeError('Cannot delete property of null');

  const trueType: i32 = Porffor.type(obj);
  if (trueType == Porffor.TYPES.array) {
    const index: i32 = __Porffor_array_propertyKeyIndex(ecma262.ToPropertyKey(key));
    if (index != -1) {
      __Porffor_array_delete(obj as any[], index);
      return true;
    }
  }

  if (Porffor.type(obj) != Porffor.TYPES.object) {
    obj = __Porffor_object_underlying(obj);
    if (Porffor.type(obj) != Porffor.TYPES.object) return true;
  }

  const entryPtr: i32 = __Porffor_object_lookup(obj, key, __Porffor_object_hash(key));
  if (entryPtr == 0) {
    // not found, stop
    return true;
  }

  const tail: i32 = Porffor.IR.loadU16(entryPtr, 16);
  if (!(tail & 0b0010)) {
    // not configurable
    return false;
  }

  __Porffor_object_removeEntry(obj, entryPtr, key, __Porffor_object_hash(key));
  return true;
};

export const __Porffor_object_deleteStrict = (obj: any, key: any): boolean => {
  if (Porffor.IR.ptr(obj) == 0) throw new TypeError('Cannot delete property of null');

  const trueType: i32 = Porffor.type(obj);
  if (trueType == Porffor.TYPES.array) {
    const index: i32 = __Porffor_array_propertyKeyIndex(ecma262.ToPropertyKey(key));
    if (index != -1) {
      __Porffor_array_delete(obj as any[], index);
      return true;
    }
  }

  if (Porffor.type(obj) != Porffor.TYPES.object) {
    obj = __Porffor_object_underlying(obj);
    if (Porffor.type(obj) != Porffor.TYPES.object) return true;
  }

  const entryPtr: i32 = __Porffor_object_lookup(obj, key, __Porffor_object_hash(key));
  if (entryPtr == 0) {
    // not found, stop
    return true;
  }

  const tail: i32 = Porffor.IR.loadU16(entryPtr, 16);
  if (!(tail & 0b0010)) {
    // not configurable
    throw new TypeError('Cannot delete non-configurable property of object');
  }

  __Porffor_object_removeEntry(obj, entryPtr, key, __Porffor_object_hash(key));
  return true;
};


export const __Porffor_object_isEnumerable = (entryPtr: i32): boolean => {
  return (Porffor.IR.loadU8(entryPtr, 16) & 0b0100) != 0;
};


// used for { foo: 5 }
export const __Porffor_object_expr_init = (obj: any, key: any, value: any): void => {
  if (Porffor.type(obj) != Porffor.TYPES.object) obj = __Porffor_object_underlying(obj);

  const hash: i32 = __Porffor_object_hash(key);
  let entryPtr: i32 = __Porffor_object_lookup(obj, key, hash);
  if (entryPtr == 0) {
    if (hash == 212292208) if (Porffor.strcmp(key, '__proto__')) {
      // set prototype
      __Porffor_object_setPrototype(obj, value);
      return value;
    }

  }

  __Porffor_object_commit(obj, entryPtr, key, hash, -2, 0b1110, value, undefined, undefined);
};

// used for { get foo() {} }
export const __Porffor_object_expr_get = (obj: any, key: any, get: any): void => {
  if (Porffor.type(obj) != Porffor.TYPES.object) obj = __Porffor_object_underlying(obj);

  const hash: i32 = __Porffor_object_hash(key);
  let entryPtr: i32 = __Porffor_object_lookup(obj, key, hash);
  let set: any = undefined;
  if (entryPtr == 0) {
  } else if (Porffor.IR.loadU8(entryPtr, 16) & 0b0001) {
    // existing entry, keep set (if exists)
    set = __Porffor_object_accessorSet(entryPtr);
  }

  // write new accessor pair, flags = writable, enumerable, configurable, accessor
  __Porffor_object_commit(obj, entryPtr, key, hash, -2, 0b1111, undefined, get, set);
};

// used for { set foo(v) {} }
export const __Porffor_object_expr_set = (obj: any, key: any, set: any): void => {
  if (Porffor.type(obj) != Porffor.TYPES.object) obj = __Porffor_object_underlying(obj);

  const hash: i32 = __Porffor_object_hash(key);
  let entryPtr: i32 = __Porffor_object_lookup(obj, key, hash);
  let get: any = undefined;
  if (entryPtr == 0) {
  } else if (Porffor.IR.loadU8(entryPtr, 16) & 0b0001) {
    // existing entry, keep get (if exists)
    get = __Porffor_object_accessorGet(entryPtr);
  }

  // write new accessor pair, flags = writable, enumerable, configurable, accessor
  __Porffor_object_commit(obj, entryPtr, key, hash, -2, 0b1111, undefined, get, set);
};


// used for { foo: 5 }
export const __Porffor_object_class_value = (obj: any, key: any, value: any): void => {
  if (Porffor.type(obj) != Porffor.TYPES.object) obj = __Porffor_object_underlying(obj);

  const hash: i32 = __Porffor_object_hash(key);
  let entryPtr: i32 = __Porffor_object_lookup(obj, key, hash);
  if (entryPtr == 0) {
    // add new entry
    // check if object is inextensible
    if (__Porffor_object_isInextensible(obj)) {
      throw new TypeError('Cannot define property, object is inextensible');
    }
  }

  __Porffor_object_commit(obj, entryPtr, key, hash, -2, 0b1110, value, undefined, undefined);
};

// used for { foo() {} }
export const __Porffor_object_class_method = (obj: any, key: any, value: any): void => {
  if (Porffor.type(obj) != Porffor.TYPES.object) obj = __Porffor_object_underlying(obj);

  const hash: i32 = __Porffor_object_hash(key);
  let entryPtr: i32 = __Porffor_object_lookup(obj, key, hash);
  if (entryPtr == 0) {
    // add new entry
    // check if object is inextensible
    if (__Porffor_object_isInextensible(obj)) {
      throw new TypeError('Cannot define property, object is inextensible');
    }
  }

  __Porffor_object_commit(obj, entryPtr, key, hash, -2, 0b1010, value, undefined, undefined);
};

// used for { get foo() {} }
export const __Porffor_object_class_get = (obj: any, key: any, get: any): void => {
  if (Porffor.type(obj) != Porffor.TYPES.object) obj = __Porffor_object_underlying(obj);

  const hash: i32 = __Porffor_object_hash(key);
  let entryPtr: i32 = __Porffor_object_lookup(obj, key, hash);
  let set: any = undefined;
  if (entryPtr == 0) {
    // add new entry
    // check if object is inextensible
    if (__Porffor_object_isInextensible(obj)) {
      throw new TypeError('Cannot define property, object is inextensible');
    }
  } else if (Porffor.IR.loadU8(entryPtr, 16) & 0b0001) {
    // existing entry, keep set (if exists)
    set = __Porffor_object_accessorSet(entryPtr);
  }

  // write new accessor pair, flags = writable, enumerable, configurable, accessor
  __Porffor_object_commit(obj, entryPtr, key, hash, -2, 0b1011, undefined, get, set);
};

// used for { set foo(v) {} }
export const __Porffor_object_class_set = (obj: any, key: any, set: any): void => {
  if (Porffor.type(obj) != Porffor.TYPES.object) obj = __Porffor_object_underlying(obj);

  const hash: i32 = __Porffor_object_hash(key);
  let entryPtr: i32 = __Porffor_object_lookup(obj, key, hash);
  let get: any = undefined;
  if (entryPtr == 0) {
    // add new entry
    // check if object is inextensible
    if (__Porffor_object_isInextensible(obj)) {
      throw new TypeError('Cannot define property, object is inextensible');
    }
  } else if (Porffor.IR.loadU8(entryPtr, 16) & 0b0001) {
    // existing entry, keep get (if exists)
    get = __Porffor_object_accessorGet(entryPtr);
  }

  // write new accessor pair, flags = writable, enumerable, configurable, accessor
  __Porffor_object_commit(obj, entryPtr, key, hash, -2, 0b1011, undefined, get, set);
};
