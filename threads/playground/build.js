// builds what the playground loads besides its sources: node threads/playground/build.js
//   build/sysroot.tar   the parts of a wasm32-wasip1-threads sysroot that Porffor's C needs
//                       (libc headers and libraries, compiler-rt builtins), for clang in the page
//   build/presets/      each preset compiled ahead of time, so running one needs no clang download
// WASI_SYSROOT, CLANG_RT and WASM_CLANG override where the sysroot, the threads builtins
// library and a clang that targets wasm are found (homebrew's wasi-libc, wasi-runtimes and llvm
// by default)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.join(here, 'build');

const first = (...xs) => xs.find(x => x && fs.existsSync(x));
const sysroot = first(process.env.WASI_SYSROOT, '/opt/homebrew/share/wasi-sysroot', '/opt/wasi-sdk/share/wasi-sysroot');
const clangRt = first(process.env.CLANG_RT,
  '/opt/homebrew/opt/wasi-runtimes/share/wasi-runtimes/lib/wasm32-unknown-wasip1-threads/libclang_rt.builtins.a',
  ...(fs.existsSync('/opt/wasi-sdk/lib/clang') ? fs.readdirSync('/opt/wasi-sdk/lib/clang').map(v => `/opt/wasi-sdk/lib/clang/${v}/lib/wasm32-unknown-wasip1-threads/libclang_rt.builtins.a`) : []));
const clang = first(process.env.WASM_CLANG, '/opt/homebrew/opt/llvm/bin/clang', '/opt/wasi-sdk/bin/clang');
if (!sysroot || !clangRt) {
  console.error('need a wasm32-wasip1-threads sysroot and compiler-rt builtins: set WASI_SYSROOT and CLANG_RT');
  process.exit(1);
}

// the flags clang gets in the page too (keep compiler.worker.js in step)
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

// a minimal ustar writer: the page reads it back with the reader in compiler.worker.js
const tar = files => {
  const blocks = [];
  for (const [name, data] of files) {
    if (name.length > 100) throw new Error(`name too long for tar: ${name}`);
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0' + '00', 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
};

// the headers Porffor's C includes, and everything they include in turn (ignoring #if, so
// a few more than needed). ones not in the sysroot are clang's own, which clang brings
const includeDir = path.join(sysroot, 'include', 'wasm32-wasip1-threads');
const headers = new Map();
const visit = (name, from) => {
  const file = [ from && path.join(path.dirname(from), name), path.join(includeDir, name) ].find(x => x && fs.existsSync(x));
  if (!file || headers.has(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  headers.set(file, text);
  for (const m of text.matchAll(/^\s*#\s*include(?:_next)?\s*[<"]([^>"]+)[>"]/gm)) visit(m[1], file);
};
const render = fs.readFileSync(path.join(root, 'compiler', 'render.js'), 'utf8');
for (const m of new Set([ ...render.matchAll(/#include <([^>]+\.h)>/g) ].map(m => m[1]))) visit(m);

const libDir = path.join(sysroot, 'lib', 'wasm32-wasip1-threads');
const libs = [ 'crt1-command.o', 'libc.a', 'libsetjmp.a',
  'libwasi-emulated-mman.a', 'libwasi-emulated-signal.a', 'libwasi-emulated-process-clocks.a' ];

const licenseDir = path.resolve(path.dirname(fs.realpathSync(path.join(libDir, 'libc.a'))), '../../../..');
const licenses = fs.existsSync(licenseDir) ? fs.readdirSync(licenseDir).filter(x => /^LICENSE/.test(x)) : [];

const files = [
  ...[ ...headers.keys() ].map(f => [ 'sysroot/' + path.relative(sysroot, f), fs.readFileSync(f) ]),
  ...libs.map(l => [ `sysroot/lib/wasm32-wasip1-threads/${l}`, fs.readFileSync(path.join(libDir, l)) ]),
  [ 'rt/libclang_rt.builtins.a', fs.readFileSync(clangRt) ],
  ...licenses.map(l => [ `licenses/wasi-libc/${l}`, fs.readFileSync(path.join(licenseDir, l)) ])
];
fs.mkdirSync(out, { recursive: true });
const sysrootTar = tar(files);
fs.writeFileSync(path.join(out, 'sysroot.tar'), sysrootTar);
console.log(`build/sysroot.tar: ${headers.size} headers, ${libs.length + 1} libraries, ${(sysrootTar.length / 1024).toFixed(0)} KB`);

// presets, compiled with this tree's compiler and a native clang
if (!clang) {
  console.log('no clang that targets wasm (set WASM_CLANG): skipping the presets');
  process.exit(0);
}
const presetDir = path.join(here, 'presets');
const builtDir = path.join(out, 'presets');
fs.mkdirSync(builtDir, { recursive: true });
const manifest = {};
const tmp = fs.mkdtempSync(path.join(out, 'tmp-'));
try {
  for (const f of fs.readdirSync(presetDir).filter(x => x.endsWith('.js'))) {
    const name = f.slice(0, -3);
    const source = fs.readFileSync(path.join(presetDir, f), 'utf8');
    const c = path.join(tmp, `${name}.c`);
    execFileSync(process.execPath, [ path.join(root, 'runtime', 'index.js'), 'c', path.join(presetDir, f), '-o', c ], { stdio: [ 'ignore', 'ignore', 'inherit' ] });
    execFileSync(clang, [ ...clangFlags, `--sysroot=${sysroot}`, c, '-o', path.join(builtDir, `${name}.wasm`), ...linkFlags, clangRt ], { stdio: 'inherit' });
    manifest[name] = crypto.createHash('sha256').update(source).digest('hex');
    console.log(`build/presets/${name}.wasm`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
fs.writeFileSync(path.join(builtDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
