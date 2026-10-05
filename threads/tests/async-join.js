// asyncJoin: promises for thread results, settled by the job loop (finished threads first),
// rejections for threads that threw, and awaiting them in an async function
const SCALE = 1; // run.js lowers this for sanitizer and gc stress runs
const slow = new Thread(() => { let s = 0; for (let i = 0; i < 3e7 * SCALE; i++) s += i & 1; return 'slow ' + (s === 1.5e7 * SCALE); });
const fast = new Thread(() => 'fast');
const boom = new Thread(() => { throw new Error('boom'); });
const order = [];
const ps = [
  slow.asyncJoin().then(v => order.push(v)),
  fast.asyncJoin().then(v => order.push(v)),
  boom.asyncJoin().then(() => order.push('no'), e => order.push('caught ' + e.message)),
  (async () => {
    const both = await Promise.all([ new Thread(() => 1).asyncJoin(), new Thread(() => 2).asyncJoin() ]);
    order.push('all ' + both.join('+'));
  })()
];
Promise.all(ps).then(() => console.log(order.length, order.includes('slow true'), order.includes('fast'), order.includes('caught boom'), order.includes('all 1+2')));
console.log('sync part done');
