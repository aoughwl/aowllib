# aowllib

The **aowl system module + runtime**: the hand-written C runtime that provides
the `system` / `syncio` symbols a post-`hexer` `.c.nif` references, so **real
nimony programs — `echo`, strings, seqs, `ref` objects with ARC — link and run
natively** through [aifc](https://github.com/aoughwl/aifc), with **no** nimony
54 KB `system.c.nif`.

> Status: **working.** `echo "hello"` and 43 other programs — strings (concat,
> build, `$`, indexing, `==`/`<`/`<=`, `case`-on-string, `for c in s`, slicing, mutation), seqs
> (growth, nesting, assignment, return-by-value, bounds checks), case objects, inheritance with method dispatch, `object`/`ref`
> with heap-typed fields, non-zero-based arrays with bounds panics, `INT64_MIN`
> and SSO tier boundaries — compile to native binaries through `aifc` + `aowllib`
> and pass a 44/44 acceptance suite, **ASan/UBSan/LSan-clean, leak-free**. This
> is the biggest unlock in the
> [aifmony](https://github.com/aoughwl/aifmony) rewrite: it's what lets a program
> compile *natively* through the self-owned stack instead of running under the
> [nifi](https://github.com/aoughwl/aifi) interpreter.

```sh
npm test            # build every example .c.nif natively + assert output (node + gcc)
npm run test:regen  # also regenerate each .c.nif from its .nim first (needs nimony)
```

```
  ok    hello      hello, nimony
  ok    echo_str   greetings from aowllib
  ok    echo_int   42
  ok    concat     foobar
  ok    strbuild   ababab
  ok    seqsum     15
  ok    refobj     7
  ok    longstr    the quick brown fox jumps over the lazy dog
  ok    foriter    h
  ok    objseq     4
  ok    arroob     index out of bounds: 5 notin 0..2
  …
  44/44 passed
```

## What it is

By the time `hexer` has lowered a program, ARC calls and runtime operations are
*injected* into the `.c.nif` — they reference runtime symbols (`write`, the
string/seq structs, `=destroy`, `allocFixed`, `arcInc`, …) that must exist at
link time. Nimony gets them by compiling its `system` module to `.c.nif`.
**aowllib provides them as an aowl-owned C layer instead.**

The trick: those symbols are **content-addressed** — `write.0.syn1lfpjv` carries
the hash of the `syncio` module. aowllib is written once with clean,
hash-independent names (`aowllib_write_string`, …); the linker `bin/aowllib-cc`
reads the *actual* symbols a given `.c.nif` uses and generates a per-program
shim that aliases them onto aowllib. Any runtime symbol aowllib doesn't cover is
reported as an explicit coverage gap, never silently stubbed.

```
  .c.nif ──aifc.compileModule──▶ C ──inject shim──▶ gcc + runtime/aowllib.c ──▶ native binary
             (the printer)         (hashed→aowllib)        (the runtime)
```

## Layout

| path | what |
|---|---|
| `runtime/aowllib.h` / `aowllib.c` | the C runtime: string SSO, seq, ARC, allocator, IO, `$`, panics |
| `runtime/runtime-map.js` | nimony symbol base → aowllib entry point + the shim C |
| `bin/aowllib-cc.js` | link a `.c.nif` into a native binary (print → shim → gcc) |
| `examples/*.nim` / `*.c.nif` | source + committed post-hexer IR for the suite |
| `test/run.sh`, `test/expected/` | the acceptance suite |
| `docs/runtime.md` | the runtime contract in detail (layouts, SSO, ABI, coverage) |

## Usage

```sh
# compile a post-hexer .c.nif to a native binary and run it:
node bin/aowllib-cc.js path/to/module.c.nif -o ./prog --run

# from Nim source (needs the nimony toolchain):
test/gen-cnif.sh foo.nim foo.c.nif
node bin/aowllib-cc.js foo.c.nif -o foo && ./foo
```

`aowllib-cc` resolves `aifc` from `$AOWLLIB_AIFC`, then `~/aifc/nifc.js`. The
`.nim → .c.nif` step resolves nimony from `$AOWLLIB_NIMONY`, then `~/nimony/bin`.

## Design notes

- **SSO strings** mirror `lib/std/system/stringimpl.nim`: `slen` in the low byte
  of `bytes`, tiers short(≤7) / medium(≤14) / long(255) / static(254). Literals
  lower to a static `LongString`; `LongString.data` is a **pointer** (one heap
  allocation per string, header + data + NUL) rather than nimony's inline
  flexible array — that is exactly what `aifc` emits for a literal const and it
  keeps freeing a string a single `free`.
- **ARC** is single-threaded: `rc` stores `refcount-1` (0 = unique), matching
  `system/arcops.nim`. `=destroy`/`=copy`/`=dup` for strings live here; seq and
  user-`ref` hooks are monomorphised into the program by `hexer`.
- Per the aoughwl convention, this hand-written C runtime is the **bootstrap
  seed & oracle** for the eventual aowl-native `system` module (Phase 2).

See [docs/runtime.md](docs/runtime.md) for the full contract and coverage table.

## License

MIT.
