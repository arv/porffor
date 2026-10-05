// builtins with process-wide state, used from several threads at once (no shared objects)
const run = (name, body) => {
  const ts = [];
  for (let i = 0; i < 6; i++) ts.push(new Thread(() => body(i)));
  const rs = ts.map(t => { try { return t.join(); } catch (e) { return 'threw ' + e; } });
  const ok = rs.every(r => r === true);
  console.log(name, ok ? 'ok' : 'BAD ' + rs.join(' '));
};

run('regexp', i => {
  for (let k = 0; k < 3000; k++) {
    const re = new RegExp('(a+)(b' + (i % 3) + ')?c' + k % 7);
    const s = 'xx' + 'a'.repeat(i + 1) + 'b' + (i % 3) + 'c' + k % 7;
    const m = re.exec(s);
    if (!m || m[1] !== 'a'.repeat(i + 1)) return false;
  }
  return true;
});

run('dataview', i => {
  const dv = new DataView(new ArrayBuffer(16));
  for (let k = 0; k < 20000; k++) {
    const v = i * 1000 + k + 0.5;
    dv.setFloat64(0, v);
    if (dv.getFloat64(0) !== v) return false;
    dv.setFloat32(8, i + 0.25);
    if (dv.getFloat32(8) !== i + 0.25) return false;
  }
  return true;
});

run('function props', i => {
  for (let k = 0; k < 2000; k++) {
    const f = function () {};
    f.tag = 't' + i + ':' + k;
    if (f.tag !== 't' + i + ':' + k || f.name !== 'f') return false;
  }
  return true;
});

run('symbol registry', i => {
  for (let k = 0; k < 2000; k++) {
    const key = 'k' + (k % 50);
    if (Symbol.for(key) !== Symbol.for(key) || Symbol.keyFor(Symbol.for(key)) !== key) return false;
  }
  return true;
});

run('json', i => {
  for (let k = 0; k < 2000; k++) {
    const o = { i, k, s: 'v' + k, a: [k, i] };
    const back = JSON.parse(JSON.stringify(o));
    if (back.s !== 'v' + k || back.a[1] !== i) return false;
  }
  return true;
});

run('strings', i => {
  for (let k = 0; k < 5000; k++) {
    const s = ('x' + i + '-' + k).padStart(12, '0').toUpperCase().split('-').reverse().join('+');
    if (s !== k + '+' + ('X' + i).padStart(12 - String(k).length - 1, '0')) return false;
  }
  return true;
});
