// shared-everything races on one object: memory safety only (values may be stale or
// interleaved, but every value must be one that some thread actually wrote)
const SCALE = 1; // run.js lowers this for sanitizer and gc stress runs
const shared = {};
const protoA = { fromProto: 'A' }, protoB = { fromProto: 'B' };
const ok = v => v === undefined || typeof v === 'string' || typeof v === 'number' ||
  (typeof v === 'object' && v !== null && typeof v.t === 'number');

const worker = t => () => {
  let bad = 0;
  for (let i = 0; i < 30000 * SCALE; i++) {
    const k = 'k' + ((i * 13 + t) % 40);
    const op = (i + t) % 6;
    if (op === 0) shared[k] = { t, i };
    else if (op === 1) shared[k] = 's' + t;
    else if (op === 2) delete shared[k];
    else if (op === 3) shared[k] = i * 0.5;
    else if (op === 4 && (i & 63) === 0) Object.defineProperty(shared, 'acc' + (i % 3), { get() { return 'g' + t; }, configurable: true, enumerable: true });
    else if (op === 5 && (i & 127) === 0) Object.setPrototypeOf(shared, (i & 128) ? protoA : protoB);

    if (!ok(shared['k' + ((i * 7) % 40)])) bad++;
    const a = shared['acc' + (i % 3)];
    if (a !== undefined && (typeof a !== 'string' || a[0] !== 'g')) bad++;
    const p = shared.fromProto;
    if (p !== undefined && p !== 'A' && p !== 'B') bad++;
    if ((i & 511) === 0) {
      for (const kk of Object.keys(shared)) if (typeof kk !== 'string') bad++;
      for (const kk in shared) if (typeof kk !== 'string') bad++;
      for (const v of Object.values(shared)) if (!ok(v) && !(typeof v === 'string')) bad++;
    }
  }
  return bad;
};

const ts = [];
for (let t = 0; t < 4; t++) ts.push(new Thread(worker(t)));
const bads = ts.map(x => x.join());
console.log(bads.every(b => b === 0) ? 'ok' : 'BAD ' + bads.join(','));
