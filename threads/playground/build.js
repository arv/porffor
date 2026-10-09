// builds what the playground loads besides its sources: node threads/playground/build.js
//   build/sysroot.tar   the parts of a wasm32-wasip1-threads sysroot that Porffor's C needs
//                       (libc headers and libraries, compiler-rt builtins), for clang in the page
//   build/presets/      each preset compiled ahead of time, so running one needs no clang download
// the sysroot and builtins come from homebrew's wasi-libc and wasi-runtimes or from wasi-sdk
// if installed, or else from wasi-sdk's release (downloaded once, into build/wasi-sdk). the
// presets need a clang that targets wasm (homebrew's llvm or wasi-sdk's); without one, the page
// compiles them the first time they run. WASI_SYSROOT, CLANG_RT and WASM_CLANG override all this
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.join(here, 'build');

const first = (...xs) => xs.find(x => x && fs.existsSync(x));
const brews = [ '/opt/homebrew', '/usr/local', '/home/linuxbrew/.linuxbrew' ];
const wasiSdkRt = fs.existsSync('/opt/wasi-sdk/lib/clang') ? fs.readdirSync('/opt/wasi-sdk/lib/clang').map(v => `/opt/wasi-sdk/lib/clang/${v}/lib/wasm32-unknown-wasip1-threads/libclang_rt.builtins.a`) : [];
const rtPath = 'wasm32-unknown-wasip1-threads/libclang_rt.builtins.a';

// a wasi-sdk release archive, downloaded into build/wasi-sdk and unpacked there (just members)
const RELEASE = 'https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34';
const cache = path.join(out, 'wasi-sdk');
const fromRelease = async (archive, members) => {
  fs.mkdirSync(cache, { recursive: true });
  const file = path.join(cache, archive);
  console.log(`downloading ${archive} from ${RELEASE}`);
  const res = await fetch(`${RELEASE}/${archive}`);
  if (!res.ok) throw new Error(`${archive}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
  execFileSync('tar', [ 'xzf', file, '-C', cache, ...members ]);
  fs.rmSync(file);
};

let sysroot = first(process.env.WASI_SYSROOT, ...brews.map(b => `${b}/share/wasi-sysroot`), '/opt/wasi-sdk/share/wasi-sysroot');
let clangRt = first(process.env.CLANG_RT, ...brews.map(b => `${b}/opt/wasi-runtimes/share/wasi-runtimes/lib/${rtPath}`), ...wasiSdkRt);
const clang = first(process.env.WASM_CLANG, ...brews.map(b => `${b}/opt/llvm/bin/clang`), '/opt/wasi-sdk/bin/clang');
// clang links wasm with wasm-ld, found on PATH or beside clang. homebrew's llvm leaves it out
// (it is in homebrew's lld)
const wasmLd = first(...(process.env.PATH ?? '').split(path.delimiter).map(d => d && path.join(d, 'wasm-ld')),
  clang && path.join(path.dirname(clang), 'wasm-ld'), ...brews.map(b => `${b}/opt/lld/bin/wasm-ld`));
if (!sysroot || !fs.existsSync(path.join(sysroot, 'lib', 'wasm32-wasip1-threads', 'libc.a'))) {
  sysroot = path.join(cache, 'wasi-sysroot-34.0');
  if (!fs.existsSync(path.join(sysroot, 'lib', 'wasm32-wasip1-threads', 'libc.a')))
    await fromRelease('wasi-sysroot-34.0.tar.gz', [ 'wasi-sysroot-34.0/include/wasm32-wasip1-threads', 'wasi-sysroot-34.0/lib/wasm32-wasip1-threads' ]);
}
if (!clangRt) {
  clangRt = path.join(cache, 'libclang_rt-34.0', rtPath);
  if (!fs.existsSync(clangRt)) await fromRelease('libclang_rt-34.0.tar.gz', [ `libclang_rt-34.0/${rtPath}` ]);
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
if (!clang || !wasmLd) {
  console.log(!clang ? 'no clang that targets wasm (set WASM_CLANG): skipping the presets'
    : 'no wasm-ld (brew install lld): skipping the presets');
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
    execFileSync(clang, [ ...clangFlags, `--sysroot=${sysroot}`, c, '-o', path.join(builtDir, `${name}.wasm`), ...linkFlags, clangRt ],
      { stdio: 'inherit', env: { ...process.env, PATH: `${path.dirname(wasmLd)}${path.delimiter}${process.env.PATH ?? ''}` } });
    manifest[name] = crypto.createHash('sha256').update(source).digest('hex');
    console.log(`build/presets/${name}.wasm`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
fs.writeFileSync(path.join(builtDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
