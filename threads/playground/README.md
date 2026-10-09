# Threads playground

A page to write and run threaded JavaScript in the browser: Porffor compiles it to C, clang
compiles the C to WebAssembly, and each thread runs in a Web Worker on one shared memory. All
of it happens in the page, with no server beyond static files.

```sh
node threads/playground/build.js   # once, and after changing the compiler or a preset
node threads/playground/serve.js   # then open http://localhost:8787/threads/playground/
```

`build.js` needs a wasm32-wasip1-threads sysroot and its compiler-rt builtins (homebrew's
`wasi-libc` and `wasi-runtimes`, or wasi-sdk; `WASI_SYSROOT` and `CLANG_RT` point elsewhere),
and a clang that targets wasm for the presets (`WASM_CLANG`). It writes `build/`:
- `sysroot.tar`: the libc headers Porffor's C includes, libc and the builtins, about 1.3 MB.
  clang in the page compiles against it.
- `presets/`: the examples compiled ahead of time, so running one downloads no compiler. An
  edited example, or any other code, is compiled in the page.

## How it works

- **JS to C**: `compiler.worker.js` imports Porffor's compiler from `../../compiler/`,
  unchanged. It already avoids node APIs when `process.version` is missing.
- **C to Wasm**: the same worker runs clang and lld built for WebAssembly by
  [YoWASP](https://yowasp.org) (`@yowasp/clang`, from jsDelivr, about 25 MB compressed and
  then cached by the browser) against `build/sysroot.tar`, with the flags
  `threads/README.md`'s Wasm build uses, plus a 256 MB heap instead of WASI's 64 MB default.
  Compiling a small program takes 3-5 s.
- **Running**: `runner.js` makes one shared `WebAssembly.Memory`, a pool of workers
  (`thread.worker.js`, as many as the browser reports cores) and a main worker that runs
  `_start`. Each worker instantiates the module on the shared memory and implements the
  WASI calls Porffor uses. `thread-spawn` queues the new thread in shared memory, where an
  idle pool worker takes it. A spawning thread may block straight away (in `join`, say), so it
  never waits for a worker: if none is idle it asks the page for another, which keeps
  programs that need many threads at once (a barrier for 32 of them, say) from deadlocking.
- **The timeline** shows, for each worker, when it ran a thread: workers write the start and
  end times into shared memory, and the page draws them.
- **The chart** reads lines like `threads 4  290 ms` from the output.

SharedArrayBuffer needs a cross-origin isolated page. `serve.js` sends the COOP/COEP headers;
on a static host that cannot (GitHub Pages, say), `sw.js` adds them from a service worker
after one reload. It also needs WebAssembly threads and exception handling with `exnref`, as in
current Chrome, Firefox and Safari.

## The examples

Each runs its work with 1, 2, 4 and 8 threads and prints the times:
- **Hello, threads**: the API: shared arrays, Maps and objects, `Lock`, `Atomics.wait`,
  `asyncJoin`.
- **Mandelbrot**: rows taken from a shared counter (`Atomics.add`) and written into one plain
  array, then drawn with terminal colors. Pure floating point: close to linear, and on one
  thread about as fast as V8 runs the same code.
- **N-body**: bodies as plain objects in a shared array, each thread moving its own slice and
  reading everyone's, with a barrier built from `Lock` and `Condition`.
- **Word count**: one big shared string, a `Map` per thread, merged by the main thread.
  Allocation heavy, so collections (which stop every thread) limit it.

Porffor's single-threaded code is still slower than V8's where its type inference gives up
(property reads, `+=` on a variable it cannot type): the examples use `+x` in a few places to
help it. What they show is how the time falls as threads are added.
