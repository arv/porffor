// the prototype read IC under races: threads call a method through one shared site while
// others swap the receivers' prototypes, replace the method on a prototype, and add and delete
// shadowing own methods. every call gets one of the methods it could see, never another key's
// value, and nothing crashes
const SCALE = 1; // run.js lowers this for sanitizer and gc stress runs
const N = 4, PER = 20000 * SCALE;
class A { m() { return 1; } x() { return -1; } }
class B { m() { return 2; } x() { return -2; } }
const objs = [];
for (let i = 0; i < 16; i++) objs.push(new A());
const call = o => o.m();
const go = new Int32Array(new SharedArrayBuffer(4));
const ts = [];
for (let t = 0; t < N; t++) ts.push(new Thread(() => {
  while (Atomics.load(go, 0) === 0) {}
  let bad = 0;
  for (let i = 0; i < PER; i++) {
    const o = objs[(i * 7 + t) & 15];
    if (t === 0 && (i & 63) === 0) Object.setPrototypeOf(o, (i & 128) ? B.prototype : A.prototype);
    if (t === 1 && (i & 255) === 0) A.prototype.m = (i & 256) ? function () { return 3; } : function () { return 1; };
    if (t === 2 && (i & 511) === 0) o.m = function () { return 4; };
    if (t === 2 && (i & 511) === 256) delete o.m;
    const r = call(o);
    if (r !== 1 && r !== 2 && r !== 3 && r !== 4) bad++;
  }
  return bad;
}));
Atomics.store(go, 0, 1);
let bad = 0;
for (const t of ts) bad += t.join();
console.log(bad === 0 ? 'ok' : 'BAD ' + bad);
