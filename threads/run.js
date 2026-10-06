// runs the thread tests (threads/tests/*.js): each compiles to C, builds with cc, runs, and
// its output must match tests/<name>.out
//   node threads/run.js [names...]   all tests, or the ones named
//   --stress=N    force a minor collection every N allocations (all threads together)
//   --tsan        build with -fsanitize=thread; reports count as failures (but see tsanBenign)
//   --cc=gcc      the C compiler (default cc)
//   --update      write each test's output as its .out instead of checking it
// stress and tsan runs lower the tests' SCALE, so they finish in reasonable time
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testsDir = join(__dirname, 'tests');
const porf = join(__dirname, '..', 'runtime', 'index.js');

const args = process.argv.slice(2);
const opt = name => args.find(x => x.startsWith(`--${name}=`))?.split('=')[1];
const stressEvery = opt('stress') ? parseInt(opt('stress')) : 0;
const tsan = args.includes('--tsan');
const update = args.includes('--update');
const cc = opt('cc') ?? 'cc';
const names = args.filter(x => !x.startsWith('--'));

// races tsan reports by design: racing accesses that are fine by the threads model
const tsanBenign = {
  'race-object-memory-safety': 'a property\'s attribute byte, read without the lock while a writer commits'
};

// porf_alloc forces a minor collection every N allocations, except inside one it caused
const stress = (c, n) => {
  const reps = [
    [ 'static inline u32 porf_alloc(u32 bytes, u32 typeId) {\n', `static void porf_gc_minor(void);
static u32 porf_stress_n;
static _Thread_local int porf_stress_busy;
static inline u32 porf_alloc(u32 bytes, u32 typeId) {
  if (porf_heap_base != 0 && !porf_stress_busy && (__atomic_add_fetch(&porf_stress_n, 1, __ATOMIC_RELAXED) % ${n}) == 0) { porf_stress_busy++; porf_gc_minor(); porf_stress_busy--; }
` ],
    [ 'if (porf_gc_refill_window((i32)ci)) return porf_alloc(bytes, typeId);',
      'if (porf_gc_refill_window((i32)ci)) { porf_stress_busy++; const u32 r = porf_alloc(bytes, typeId); porf_stress_busy--; return r; }' ]
  ];
  for (const [ a, b ] of reps) {
    if (!c.includes(a)) throw new Error(`--stress: runtime changed, cannot find: ${a.split('\n')[0]}`);
    c = c.replace(a, () => b);
  }
  return c;
};

const tests = fs.readdirSync(testsDir).filter(x => x.endsWith('.js')).map(x => x.slice(0, -3))
  .filter(x => names.length === 0 || names.includes(x)).sort();
if (tests.length === 0) {
  console.error('no tests match');
  process.exit(1);
}

const tmp = fs.mkdtempSync(join(os.tmpdir(), 'porf-threads-'));
const small = stressEvery > 0 || tsan;
let failed = 0;
for (const name of tests) {
  const t0 = performance.now();
  const js = join(tmp, `${name}.js`), c = join(tmp, `${name}.c`), bin = join(tmp, name);
  let src = fs.readFileSync(join(testsDir, `${name}.js`), 'utf8');
  if (small) src = src.replace('const SCALE = 1;', 'const SCALE = 0.1;');
  fs.writeFileSync(js, src);

  let result;
  try {
    execFileSync(process.execPath, [ porf, 'c', js, '-o', c ], { stdio: 'pipe' });
    if (stressEvery > 0) fs.writeFileSync(c, stress(fs.readFileSync(c, 'utf8'), stressEvery));
    execFileSync(cc, [ ...(tsan ? [ '-O1', '-g', '-fsanitize=thread' ] : [ '-O2' ]), '-w', '-pthread', c, '-o', bin, '-lm' ], { stdio: 'pipe' });

    const run = spawnSync(bin, [], {
      encoding: 'utf8',
      timeout: (tsan ? 1200 : stressEvery > 0 ? 600 : 120) * 1000,
      // reports are counted from stderr, so they leave the exit status alone (darwin aborts by default)
      env: { ...process.env, TSAN_OPTIONS: 'halt_on_error=0 abort_on_error=0 exitcode=0 report_signal_unsafe=0 history_size=4' }
    });
    const out = (run.stdout ?? '').replace(/\x1b\[[0-9;]*m/g, '');
    const tsanReports = tsan ? ((run.stderr ?? '').match(/WARNING: ThreadSanitizer/g) ?? []).length : 0;
    const expectedFile = join(testsDir, `${name}.out`);

    if (run.error?.code === 'ETIMEDOUT') result = 'timed out';
      else if (run.status !== 0) result = `exit ${run.status ?? run.signal}${run.stderr ? ': ' + run.stderr.trim().split('\n').slice(-1)[0] : ''}`;
      else if (update) fs.writeFileSync(expectedFile, out);
      else if (out !== fs.readFileSync(expectedFile, 'utf8')) result = `output differs:\n${out}`;
    if (!result && tsanReports > 0) {
      if (tsanBenign[name]) console.log(`  (${name}: ${tsanReports} tsan reports by design: ${tsanBenign[name]})`);
        else result = `${tsanReports} tsan reports`;
    }
  } catch (e) {
    result = `build failed: ${(e.stderr?.toString() || e.message).trim().split('\n').slice(0, 3).join(' | ')}`;
  }

  const ms = Math.round(performance.now() - t0);
  if (result) {
    failed++;
    console.log(`FAIL ${name} (${ms}ms): ${result}`);
  } else {
    console.log(`${update ? 'wrote' : 'ok  '} ${name} (${ms}ms)`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${tests.length - failed}/${tests.length} passed${stressEvery ? `, gc stress every ${stressEvery}` : ''}${tsan ? ', tsan' : ''}`);
process.exit(failed ? 1 : 0);
