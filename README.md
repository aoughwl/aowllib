# aiflib

The **aowl system module + runtime**: the standard `system` layer and the C
runtime primitives that the native ([aifc](https://github.com/aoughwl/aifc)) and
JS ([nifjs](https://github.com/aoughwl/nifjs)) backends link against, so real
programs — strings, seqs, `echo`, ref objects with ARC — compile through the
self-owned stack **without** nimony's 54 KB `system.c.aif`.

> Status: **scaffolding.** This is the biggest remaining unlock in the
> [aifmony](https://github.com/aoughwl/aifmony) rewrite — today `echo`/strings/
> seqs run under the interpreter ([nifi](https://github.com/aoughwl/nifi), full
> runtime) while the native path covers the arithmetic/control-flow core. aiflib
> is what lets `echo "hello"` compile **natively**.

## Why it's needed

By the time [aifhexer](https://github.com/aoughwl/aifhexer) has lowered a
program, ARC calls and runtime operations are *injected* into the `.c.aif` —
they reference runtime symbols that must exist at link time. Today those come
from nimony's `system` module compiled to `.c.aif`. aiflib provides them as an
aowl-owned layer.

## The concrete surface (derived from real backend output)

A minimal `echo "hello"` lowers to `.c.aif` that references, among others:

```
LongString            struct { NI fullLen; NI rc; NI capImpl; NC8* data; }   // string payload
string                struct { NU bytes; void* more; }                        // string header (small-string-optimised)
write(File, string)                                                           // stdout write
nimFlushStdStreams()                                                          // flush
cmdCount / cmdLine                                                            // argv bridge (exportc)
```

Ref/seq programs additionally need: the ARC hooks (`=destroy`, `=copy`,
`=sink`, `=trace`), allocation (`allocFixed`/`deallocFixed` or a GC), `NimSeqV2`
layout + `newSeq`/`add`/`len`, and the `$`/`echo` numeric formatters.

## Plan

1. **C runtime core** (`runtime/aiflib.h` + `.c`): the string/seq structs, ARC
   helpers, allocator, and IO shims above — hand-written C, the seed & oracle
   for the eventual aowl-native `system`. This alone unblocks native `echo` and
   string programs through [aifc](https://github.com/aoughwl/aifc).
2. **`system` module** in aowl source, compiled through the stack, replacing the
   reused nimony `system`.
3. **stdlib** on top (`std/*`) as needed.

Per the aoughwl convention, the hand-written C runtime is the **bootstrap seed &
oracle** for the later aowl-native implementation.

## License

MIT.
