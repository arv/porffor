// shared-everything: threads see the same heap (data-race-free usage)
let fails = 0;
const check = (name, ok) => { if (!ok) { fails++; console.log('FAIL', name); } };

// 1. shared array written at disjoint indices through a captured closure
const N = 8;
const slots = new Array(N).fill(0);
const ts = [];
for (let i = 0; i < N; i++) ts.push(new Thread(() => {
  let x = 0;
  for (let k = 0; k < 100000; k++) x = (x + k * (i + 1)) % 1000003;
  slots[i] = { i, x, tag: 'slot' + i };
}));
for (const t of ts) t.join();
check('slots', slots.every((s, i) => s.i === i && s.tag === 'slot' + i));

// 2. a module global object read by many threads
const config = { base: 7, names: ['a', 'b', 'c'] };
const readers = [];
for (let i = 0; i < 6; i++) readers.push(new Thread(() => config.base * i + config.names.join('').length));
check('readers', readers.map(t => t.join()).join(',') === '3,10,17,24,31,38');

// 3. builtins with static array literals called concurrently
const joiners = [];
for (let i = 0; i < 6; i++) joiners.push(new Thread(() => {
  let out = '';
  for (let k = 0; k < 20000; k++) {
    const parts = ['t' + i, String(k), 'x'];
    out = parts.join('-');
    if (out !== 't' + i + '-' + k + '-x') return 'bad ' + out;
    const sp = out.split('-');
    if (sp.length !== 3 || sp[0] !== 't' + i) return 'badsplit ' + sp.join('|');
  }
  return out;
}));
const jr = joiners.map(t => t.join());
check('joiners', jr.every((r, i) => r === 't' + i + '-19999-x'));
if (!jr.every((r, i) => r === 't' + i + '-19999-x')) console.log(jr.join(' '));

// 4. promises inside a thread run on that thread's own job queue
const pt = new Thread(() => {
  let log = [];
  Promise.resolve(1).then(v => log.push('then' + v));
  log.push('sync');
  return log;
});
const plog = pt.join();
check('promises', plog.join(',') === 'sync,then1');

// 5. threads starting threads
const outer = new Thread(() => {
  const inner = [];
  for (let i = 0; i < 3; i++) inner.push(new Thread(() => i * i));
  return inner.map(t => t.join()).reduce((a, b) => a + b, 0);
});
check('nested', outer.join() === 5);

// 6. exceptions and toString
const thrower = new Thread(() => { throw new TypeError('nope'); });
let caught = null;
try { thrower.join(); } catch (e) { caught = e; }
check('throw', caught instanceof TypeError && caught.message === 'nope');
check('toString', String(thrower) === '[object Thread]');

console.log(fails === 0 ? 'ok' : 'BAD ' + fails);
