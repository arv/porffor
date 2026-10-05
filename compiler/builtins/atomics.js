export default () => {
  let out = `
export const __Atomics_isLockFree = (x: number): boolean => {
  switch (x) {
    case 1:
    case 2:
    case 4:
    case 8:
      return true;
  }

  return false;
};

// which integer typed array (0 int8 1 uint8 2 int16 3 uint16 4 int32 5 uint32 6 bigint64
// 7 biguint64), else a TypeError like ValidateIntegerTypedArray
export const __Porffor_atomics_kind = (ta: any): i32 => {
  switch (Porffor.type(ta)) {
    case Porffor.TYPES.int8array: return 0;
    case Porffor.TYPES.uint8array: return 1;
    case Porffor.TYPES.int16array: return 2;
    case Porffor.TYPES.uint16array: return 3;
    case Porffor.TYPES.int32array: return 4;
    case Porffor.TYPES.uint32array: return 5;
    case Porffor.TYPES.bigint64array: return 6;
    case Porffor.TYPES.biguint64array: return 7;
  }

  throw new TypeError('Atomics operation needs an integer TypedArray');
};

// the element's arena offset, like ValidateAtomicAccess (after the detached check of
// ValidateIntegerTypedArray: a detached buffer's length is ~0, see arraybuffer.ts)
export const __Porffor_atomics_addr = (ta: any, index: any, kindId: i32): i32 => {
  const buffer: i32 = Porffor.IR.loadI32(ta, 4) - Porffor.IR.loadI32(ta, 8);
  if (Porffor.IR.loadI32(buffer, 0) == -1) throw new TypeError('Atomics operation on a detached ArrayBuffer');

  const accessIndex: number = ecma262.ToIndex(index);
  if (accessIndex >= ta.length) throw new RangeError('Atomics index out of range');

  let shift: i32 = 3;
  if (kindId < 2) shift = 0;
    else if (kindId < 4) shift = 1;
    else if (kindId < 6) shift = 2;
  const elemIndex: i32 = accessIndex;
  return Porffor.IR.loadI32(ta, 4) + 4 + (elemIndex << shift);
};

// every operation but wait/notify. opCode: 0 load 1 store 2 add 3 sub 4 and 5 or 6 xor
// 7 exchange 8 compareExchange (expected, then value)
export const __Porffor_atomics_op = (ta: any, index: any, value: any, expected: any, opCode: i32): any => {
  const kindId: i32 = __Porffor_atomics_kind(ta);
  const elemAddr: i32 = __Porffor_atomics_addr(ta, index, kindId);

  if (kindId >= 6) {
    let expectedBits: i64 = 0;
    if (opCode == 8) expectedBits = __Porffor_bigint_toI64(ecma262.ToBigInt(expected));
    let newValue: bigint = 0n;
    let valueBits: i64 = 0;
    if (opCode != 0) {
      newValue = ecma262.ToBigInt(value);
      valueBits = __Porffor_bigint_toI64(newValue);
    }

    let oldBits: i64 = 0;
    Porffor.c\`oldBits = (i64)porf_atomic_op64((u32)elemAddr, opCode, (u64)valueBits, (u64)expectedBits);\`;
    if (opCode == 1) return newValue;
    if (kindId == 6) return __Porffor_bigint_fromS64(oldBits);
    return __Porffor_bigint_fromU64(oldBits);
  }

  let expectedNum: number = 0;
  if (opCode == 8) expectedNum = ecma262.ToIntegerOrInfinity(expected);
  let newNum: number = 0;
  if (opCode != 0) newNum = ecma262.ToIntegerOrInfinity(value);

  let oldNum: number = 0;
  Porffor.c\`oldNum = porf_atomic_op((u32)elemAddr, kindId, opCode, newNum, expectedNum);\`;
  if (opCode == 1) return newNum;
  return oldNum;
};

export const __Atomics_load = (ta: any, index: any): any => __Porffor_atomics_op(ta, index, undefined, undefined, 0);
export const __Atomics_store = (ta: any, index: any, value: any): any => __Porffor_atomics_op(ta, index, value, undefined, 1);
export const __Atomics_add = (ta: any, index: any, value: any): any => __Porffor_atomics_op(ta, index, value, undefined, 2);
export const __Atomics_sub = (ta: any, index: any, value: any): any => __Porffor_atomics_op(ta, index, value, undefined, 3);
export const __Atomics_and = (ta: any, index: any, value: any): any => __Porffor_atomics_op(ta, index, value, undefined, 4);
export const __Atomics_or = (ta: any, index: any, value: any): any => __Porffor_atomics_op(ta, index, value, undefined, 5);
export const __Atomics_xor = (ta: any, index: any, value: any): any => __Porffor_atomics_op(ta, index, value, undefined, 6);
export const __Atomics_exchange = (ta: any, index: any, value: any): any => __Porffor_atomics_op(ta, index, value, undefined, 7);
export const __Atomics_compareExchange = (ta: any, index: any, expected: any, replacement: any): any => __Porffor_atomics_op(ta, index, replacement, expected, 8);

// with threads the caller blocks (counting as parked for collections) until notified or
// out of time; with one thread nothing can notify, so it only sleeps out the timeout.
// every buffer is shared memory here, so unlike the spec a plain ArrayBuffer works too
export const __Atomics_wait = (ta: any, index: any, value: any, timeout: any): bytestring => {
  const kindId: i32 = __Porffor_atomics_kind(ta);
  if (Porffor.fastAnd(kindId != 4, kindId != 6)) throw new TypeError('Atomics.wait needs an Int32Array or BigInt64Array');
  const elemAddr: i32 = __Porffor_atomics_addr(ta, index, kindId);

  let expectedBits: i64 = 0;
  if (kindId == 6) expectedBits = __Porffor_bigint_toI64(ecma262.ToBigInt(value));
    else expectedBits = value | 0;

  let timeoutMs: number = Infinity;
  if (Porffor.type(timeout) != Porffor.TYPES.undefined) {
    timeoutMs = ecma262.ToNumber(timeout);
    if (timeoutMs != timeoutMs) timeoutMs = Infinity;
      else if (timeoutMs < 0) timeoutMs = 0;
  }

  let waitResult: i32 = 0;
  Porffor.c\`waitResult = porf_atomic_wait((u32)elemAddr, kindId == 6 ? 8 : 4, (u64)expectedBits, timeoutMs);\`;
  if (waitResult == 0) return 'ok';
  if (waitResult == 1) return 'not-equal';
  return 'timed-out';
};

export const __Atomics_notify = (ta: any, index: any, count: any): number => {
  const kindId: i32 = __Porffor_atomics_kind(ta);
  if (Porffor.fastAnd(kindId != 4, kindId != 6)) throw new TypeError('Atomics.notify needs an Int32Array or BigInt64Array');
  const elemAddr: i32 = __Porffor_atomics_addr(ta, index, kindId);

  let wakeCount: number = Infinity;
  if (Porffor.type(count) != Porffor.TYPES.undefined) {
    wakeCount = ecma262.ToIntegerOrInfinity(count);
    if (wakeCount < 0) wakeCount = 0;
  }

  let woken: number = 0;
  Porffor.c\`woken = porf_atomic_notify((u32)elemAddr, wakeCount);\`;
  return woken;
};

export const __Atomics_pause = (n: any): void => {
  if (Porffor.type(n) != Porffor.TYPES.undefined) {
    if (Porffor.type(n) != Porffor.TYPES.number) throw new TypeError('Atomics.pause argument must be an integral number');
    if (Porffor.fastOr(n != n, n == Infinity, n == -Infinity, Math.trunc(n) != n)) throw new TypeError('Atomics.pause argument must be an integral number');
  }
};`;

  return out;
};
