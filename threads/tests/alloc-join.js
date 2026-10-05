// each thread allocates heavily; results come back through join()
const work = (id, n) => {
  let acc = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o = { id, i, s: 'w' + id + ':' + i };
    acc.push(o);
    if (acc.length > 1000) acc = [];
    sum += o.s.length;
  }
  return { id, sum, last: acc[acc.length - 1].s };
};

const threads = [];
for (let t = 0; t < 4; t++) threads.push(new Thread(() => work(t, 300000)));
const results = threads.map(t => t.join());
const expect = work(0, 300000).sum;
console.log(results.map(r => r.id + ':' + r.sum + ':' + r.last).join(' '));
console.log(results.every(r => r.sum === expect + (r.id === 0 ? 0 : 0)) ? 'sums ok' : 'sums differ (expected for different ids)');

// exceptions propagate through join
const bad = new Thread(() => { throw new Error('boom'); });
try { bad.join(); console.log('no throw?'); } catch (e) { console.log('caught', e.message); }
