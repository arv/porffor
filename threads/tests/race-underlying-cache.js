// each thread caches where a function's (or an array's...) own properties live, so it need not
// lock the shared store every time. short-lived functions and arrays die and their addresses
// come back as new ones across collections: a new one must never see an old one's properties
const SCALE = 1; // run.js lowers this for sanitizer and gc stress runs
const N = 4, PER = 4000 * SCALE;
const ts = [];
for (let t = 0; t < N; t++) ts.push(new Thread(() => {
  let bad = 0;
  for (let i = 0; i < PER; i++) {
    const f = function () { return i; };
    if (f.tag !== undefined) bad++;
    f.tag = t * 100000 + i;
    const o = new f();
    if (Object.getPrototypeOf(o) !== f.prototype) bad++;
    if (f.tag !== t * 100000 + i) bad++;
    const arr = [ i, t ];
    if (arr.extra !== undefined) bad++;
    arr.extra = i;
    if (arr.extra !== i) bad++;
  }
  return bad;
}));
let bad = 0;
for (const x of ts) bad += x.join();
console.log(bad === 0 ? 'ok' : 'BAD ' + bad);
