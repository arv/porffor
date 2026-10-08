# Porffor &nbsp;<sup><sub>*(poor-for)*</sup></sub>
An ahead-of-time JavaScript compiler

> **This branch: shared-memory threads.** `new Thread(fn)` runs `fn` on another OS thread, sharing
> every object, array, Map, closure and global with the rest of the program, following WebKit's
> ["Concurrent JavaScript: It can work!"](https://webkit.org/blog/7846/concurrent-javascript-it-can-work/),
> which Bun is also bringing to JavaScriptCore ([oven-sh/WebKit#249](https://github.com/oven-sh/WebKit/pull/249)).
> Racing accesses never crash, never see a torn value and never lose a write to an unrelated
> property. There are `Lock`, `Condition`, `asyncJoin` and all of `Atomics` (with
> `wait`/`notify`), natively (clang, gcc) and on `wasm32-wasip1-threads`.
>
> It is a fairly small change: about 2.3k lines added in the compiler and runtime for threads,
> mostly in the C runtime (render.js) and builtins, with under 100 in codegen; 2.8k counting the
> inline caches and fixes the branch also picked up. Plus 1.3k of tests and notes. A program
> that never uses `Thread` compiles none of it in, and single-threaded code in one that does
> runs a few percent slower. See [threads/README.md](threads/README.md) for the API, how it works, what
> it costs and how it is tested.
>
> **Disclaimer:** this was mostly done iterating with the help of Claude Code (Claude Opus 5.5),
> disclosed per Porffor's [AI policy](AI_POLICY.md).

```sh
curl -fsSL https://porffor.dev/install.sh | sh
```

<hr>

```
$ cat hello.js
console.log('hello world!');
$ porf hello.js -o hello
[105ms] compiled hello.js -> hello (33.7KB)
$ ./hello
hello world!
```

<br>

Porffor is a 100% AOT compiled JS engine/runtime. There is nothing interpreted or compiled just-in-time. Porffor compiles JS to C (with an IR inbetween). We chose this approach because:
- it can be used essentially everywhere
- is relatively easy to emit and compile
- it avoids directly depending on a backend like LLVM or Cranelift
- is easily modifiable post-compile for diverse environments

## Versioning
Porffor releases use a single increasing release number. Releases are automatically published every git push after CI testing.

## Name
`purple` in Welsh is `porffor`. Why purple?
- No other JS engine is purple colored
- Purple is pretty cool
- Purple apparently represents "ambition", which accurately describes this project :)
