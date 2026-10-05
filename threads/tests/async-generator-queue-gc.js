// queued requests hold fresh objects (sent values, promises) while the body waits: they must
// stay alive through collections until their turn
async function* echo() {
  let sent = yield 'start';
  while (true) {
    const w = await Promise.resolve().then(() => ({ wrap: sent }));
    sent = yield w.wrap.tag + ':' + w.wrap.list.length;
  }
}
const it = echo();
const ps = [ it.next() ];
for (let i = 0; i < 300; i++) ps.push(it.next({ tag: 't' + i, list: new Array(i % 7 + 1).fill(i) }));
Promise.all(ps).then(rs => {
  let ok = rs[0].value === 'start';
  for (let i = 1; i < rs.length; i++) if (rs[i].value !== 't' + (i - 1) + ':' + ((i - 1) % 7 + 1)) ok = false;
  console.log(ok ? 'ok' : 'BAD', rs[1].value, rs[300].value);
});
