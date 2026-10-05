// regexps compiled on several threads at once: under gc stress a collected pattern string's
// address reused by a new one must not hit the compile cache's last-used entry
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
