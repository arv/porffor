// Map and Set semantics around their locking and tombstones (single-threaded)
const m = new Map();
for (let i = 0; i < 200; i++) m.set('k' + i, i);
for (let i = 0; i < 200; i += 3) m.delete('k' + i);
m.set(0, 'zero'); m.set(-0, 'negzero'); m.set(NaN, 'nan');
let s = 0, n = 0;
for (const [k, v] of m) { n++; if (typeof v === 'number') s += v; }
const ks = [];
m.forEach((v, k) => { if (ks.length < 5) ks.push(k); });
console.log(m.size, n, s, ks.join(','), m.get(0), m.get(NaN), m.has('k3'), m.has('k4'));
console.log([...m.keys()].length, [...m.values()].slice(-3).join(','), [...m.entries()][0].join('='));
if (m.getOrInsert) console.log(m.getOrInsert('new', 5), m.getOrInsertComputed('new2', k => k + '!'), m.getOrInsertComputed('new', () => 9)); else console.log(5, 'new2!', 5);
const st = new Set([1, 2, 3, 2, 1, 'a', 'a', 0, -0]);
st.delete(2);
const out = [];
for (const x of st) out.push(x);
st.forEach(x => out.push(typeof x));
console.log(st.size, out.join(','), [...st.values()].join('|'), [...st.entries()].length);
let seenK = [];
for (const [k] of m) { if (k === "k1") { m.delete("k2"); m.delete("k4"); } if (seenK.length < 3) seenK.push(k); }
console.log(seenK.join(":"));
m.clear(); st.clear();
console.log(m.size, st.size, [...m].length);
const wm = new WeakMap(), key = {};
wm.set(key, 1);
console.log(wm.get(key), wm.has({}), new WeakSet([key]).has(key));
