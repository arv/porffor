// the Atomics api on shared typed arrays (single-threaded): results, coercions, errors
const sab = new SharedArrayBuffer(64);
const i32 = new Int32Array(sab), u8 = new Uint8Array(sab, 32, 8), i16 = new Int16Array(sab, 40, 4), u32 = new Uint32Array(sab, 48, 4);
console.log(Atomics.add(i32, 0, 5), Atomics.add(i32, 0, 2), Atomics.load(i32, 0), Atomics.sub(i32, 0, 10), i32[0]);
console.log(Atomics.store(i32, 1, 3.7), Atomics.or(i32, 1, 8), Atomics.and(i32, 1, 10), Atomics.xor(i32, 1, 15), i32[1]);
console.log(Atomics.exchange(i32, 2, 42), Atomics.compareExchange(i32, 2, 42, 7), Atomics.compareExchange(i32, 2, 1, 9), i32[2]);
console.log(Atomics.add(u8, 0, 300), u8[0], Atomics.sub(u8, 1, 1), u8[1], Atomics.store(i16, 0, 40000), i16[0], Atomics.add(u32, 0, -1), u32[0]);
console.log(Atomics.store(i32, 3, 2 ** 40 + 5), i32[3], Atomics.store(i32, 3, -0), Atomics.store(i32, 3, Infinity) === Infinity, i32[3]);
const b64 = new BigInt64Array(new SharedArrayBuffer(32)), bu64 = new BigUint64Array(b64.buffer);
console.log(Atomics.add(b64, 0, 5n), Atomics.sub(b64, 0, 10n), Atomics.load(b64, 0), Atomics.load(bu64, 0) === 18446744073709551611n, Atomics.compareExchange(b64, 1, 0n, -1n), Atomics.exchange(bu64, 1, 3n) === 18446744073709551615n, Atomics.load(b64, 1));
console.log(Atomics.wait(i32, 0, 1, 0), Atomics.wait(i32, 0, i32[0], 10), Atomics.notify(i32, 0, 1), Atomics.wait(b64, 0, 0n, 0));
for (const bad of [() => Atomics.add(new Float64Array(4), 0, 1), () => Atomics.add(i32, 100, 1), () => Atomics.add(i32, -1, 1), () => Atomics.wait(u8, 0, 0, 0), () => Atomics.load({}, 0)])
  try { bad(); console.log('no throw'); } catch (e) { console.log(e.constructor.name); }
console.log(Atomics.isLockFree(4), Atomics.isLockFree(3));
