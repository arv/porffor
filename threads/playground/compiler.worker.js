// compiles JS to Wasm in the page. Porffor's compiler (this repository's, unchanged) turns
// the JS into C, then clang (LLVM built for Wasm by YoWASP) builds the C for
// wasm32-wasip1-threads against the sysroot that build.js packs
const YOWASP = 'https://cdn.jsdelivr.net/npm/@yowasp/clang@22.0.0-git20542-10/gen/bundle.js';
// wabt's wasm2wat, for showing a module as WebAssembly text
const WABT = 'https://cdn.jsdelivr.net/npm/wabt@1.0.39/+esm';

// the flags build.js gives the native clang (keep them in step)
const clangFlags = [
  '--target=wasm32-wasip1-threads', '-pthread', '-O2', '-w',
  '-D_WASI_EMULATED_MMAN', '-D_WASI_EMULATED_SIGNAL', '-D_WASI_EMULATED_PROCESS_CLOCKS',
  '-DPORF_ARENA_RESERVE=268435456ull', // a 256 MB heap, not the 64 MB wasi default
  '-mllvm', '-wasm-enable-sjlj', '-mexception-handling', '-mllvm', '-wasm-use-legacy-eh=false'
];
const linkFlags = [
  '-Wl,--import-memory,--export-memory,--max-memory=1073741824', '-nodefaultlibs',
  '-lc', '-lwasi-emulated-mman', '-lwasi-emulated-signal', '-lwasi-emulated-process-clocks', '-lsetjmp'
];

// Porffor reads its flags from process.argv as it loads, and only touches node APIs when
// process.version says it runs on node
globalThis.process = { argv: [], env: {}, stdout: { isTTY: false } };
globalThis.version = 'playground';
globalThis.file = 'main.js';

let porffor;
const loadPorffor = async () => {
  if (porffor) return porffor;
  const at = name => new URL(`../../compiler/${name}`, import.meta.url).href;
  await import(at('prefs.js'));
  const [ parse, codegen, render ] = await Promise.all([ 'parse.js', 'codegen.js', 'render.js' ].map(async x => (await import(at(x))).default));
  return porffor = { parse, codegen, render };
};

const toC = async code => {
  const { parse, codegen, render } = await loadPorffor();
  globalThis.pageSize = 65536 / 4;
  const cg = codegen(parse(code, {}));
  const out = render({ ...cg, prefs: { ...cg.prefs, split: false } });
  return typeof out === 'string' ? out : out.c;
};

// the files of a ustar archive, as the nested tree YoWASP takes
const untar = buffer => {
  const tree = {}, u8 = new Uint8Array(buffer), text = new TextDecoder();
  const str = (at, len) => text.decode(u8.subarray(at, at + len)).replace(/\0.*$/s, '');
  for (let at = 0; at + 512 <= u8.length && u8[at] !== 0;) {
    const name = str(at, 100), size = parseInt(str(at + 124, 12).trim(), 8);
    const parts = name.split('/');
    let dir = tree;
    for (const p of parts.slice(0, -1)) dir = dir[p] ??= {};
    dir[parts.at(-1)] = u8.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return tree;
};

let clang;
const loadClang = async () => {
  if (clang) return clang;
  const [ { runClang }, sysroot ] = await Promise.all([
    import(YOWASP),
    fetch(new URL('build/sysroot.tar', import.meta.url)).then(r => {
      if (!r.ok) throw new Error('build/sysroot.tar is missing: run node threads/playground/build.js');
      return r.arrayBuffer();
    }).then(untar)
  ]);
  return clang = { runClang, sysroot };
};

const toWasm = async (c, progress) => {
  const { runClang, sysroot } = await loadClang();
  let log = '';
  const decoder = new TextDecoder();
  const collect = b => { if (b) log += decoder.decode(b, { stream: true }); };
  try {
    const files = await runClang([ 'clang', ...clangFlags, '--sysroot=sysroot', 'main.c', '-o', 'main.wasm', ...linkFlags, 'rt/libclang_rt.builtins.a' ],
      { ...sysroot, 'main.c': c }, { stdout: collect, stderr: collect, fetchProgress: progress });
    return files['main.wasm'];
  } catch (e) {
    throw new Error(`clang failed${log ? `:\n${log}` : `: ${e.message}`}`);
  }
};

let wabt;
const toWat = async bytes => {
  wabt ??= (await import(WABT)).default();
  const module = (await wabt).readWasm(bytes, { readDebugNames: true, threads: true, exceptions: true });
  try {
    module.applyNames();
    return module.toText({ foldExprs: false, inlineExport: false });
  } finally {
    module.destroy();
  }
};

// one request at a time: Porffor's compiler keeps global state, and so may clang
let queue = Promise.resolve();
onmessage = ({ data }) => { queue = queue.then(() => handle(data)); };

const handle = async ({ id, code, stages, wasm: given }) => {
  const post = (type, more) => postMessage({ id, type, ...more });
  try {
    if (given) { post('done', { wat: await toWat(given) }); return; }

    let t = performance.now();
    const c = await toC(code);
    post('stage', { stage: 'c', ms: performance.now() - t });
    if (!stages.includes('wasm')) { post('done', { c }); return; }

    t = performance.now();
    const wasm = await toWasm(c, ({ totalLength, doneLength }) => post('download', { done: doneLength, total: totalLength }));
    post('stage', { stage: 'wasm', ms: performance.now() - t });
    postMessage({ id, type: 'done', c: stages.includes('c') ? c : undefined, wasm }, [ wasm.buffer ]);
  } catch (e) {
    post('error', { message: e instanceof Error && e.name !== 'Error' ? `${e.name}: ${e.message}` : String(e?.message ?? e) });
  }
};
