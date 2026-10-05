// top-level bindings only top-level code uses (locals of the entry function with threads):
// values survive throws, collections, and loops; ones used in a try keep their writes
let g = 0;
try { for (let i = 0; i < 10; i++) g += i; throw 1; } catch { }
let objs = [], keep = { n: 0 }, str = '', total = 0;
for (let r = 0; r < 2000; r++) {
  keep = { n: r, next: keep, s: 'x' + r };
  objs.push([ r, { r } ]);
  if (objs.length > 50) objs = objs.slice(25);
  str = str.length > 1000 ? '' : str + r;
  total += keep.n;
}
let depth = 0;
for (let k = keep; k && k.s !== undefined; k = k.next) depth++;
let caught = 'none';
try { null.x; } catch (e) { caught = e instanceof TypeError ? 'TypeError' : 'other'; }
let after = 0;
try { after = 1; throw 2; } catch (e) { after += e; }
console.log(g, depth, objs.length > 0 && objs[objs.length - 1][1].r === 1999, total, caught, after, keep.s);
new Thread(() => 0).join();
