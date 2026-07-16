/* runtime-map.js — maps nimony `system`/`syncio` symbols onto aiflib canonical
 * entry points, and supplies the C the generated shim injects.
 *
 * Keyed by the symbol *base* (the name before `.disamb.hash`).  Overloaded
 * bases (`write`) carry a `resolve(argKind, canon)` that picks the target from
 * the call-site argument.  A referenced base with no entry here is reported by
 * aiflib-cc as a coverage gap.  Keep this table in lock-step with aiflib.{h,c}.
 */
"use strict";

// Canonical aiflib struct definitions the shim injects (field names are the
// hash-independent nimony mangled names, so aifc's printed field accesses hit).
const STRUCTS = `typedef struct { NI fullLen_0; NI rc_0; NI capImpl_0; NC8* data_0; } Aiflib_LongString;
typedef struct { NU bytes_0; Aiflib_LongString* more_0; } Aiflib_string;
typedef struct { NI len_0; void* data_0; } Aiflib_seq;
typedef struct { NI fd; NU flags; } Aiflib_File;`;

// Externs the shim declares (std handles, always safe to declare).
const GLOBALS = `extern Aiflib_File aiflib_stdout;
extern Aiflib_File aiflib_stderr;
extern Aiflib_File aiflib_stdin;`;

// Prototypes for every aiflib runtime function the shim may alias to.
const PROTOS = `NI aiflib_str_len(Aiflib_string);
const NC8* aiflib_str_data(const Aiflib_string*);
void aiflib_write_string(Aiflib_File, Aiflib_string);
void aiflib_write_char(Aiflib_File, NC8);
void aiflib_write_int(Aiflib_File, NI64);
void aiflib_write_uint(Aiflib_File, NU64);
void aiflib_write_bool(Aiflib_File, NB8);
void aiflib_write_float(Aiflib_File, NF64);
void aiflib_flush_std_streams(void);
void aiflib_noop(void);
Aiflib_string aiflib_str_concat(Aiflib_string, Aiflib_string);
Aiflib_string aiflib_str_slice_ab(Aiflib_string, NI, NI);
NC8 aiflib_str_index(Aiflib_string, NI);
void aiflib_str_index_set(Aiflib_string*, NI, NC8);
Aiflib_string aiflib_new_string(NI);
void aiflib_str_add_char(Aiflib_string*, NC8);
void aiflib_str_add_str(Aiflib_string*, Aiflib_string);
Aiflib_string aiflib_dollar_int(NI64);
Aiflib_string aiflib_dollar_uint(NU64);
Aiflib_string aiflib_dollar_bool(NB8);
void aiflib_str_destroy(Aiflib_string);
void aiflib_str_copy(Aiflib_string*, Aiflib_string);
Aiflib_string aiflib_str_dup(Aiflib_string);
void aiflib_str_was_moved(Aiflib_string*);
void* aiflib_alloc(NI);
void* aiflib_alloc0(NI);
void* aiflib_realloc(void*, NI);
void aiflib_dealloc(void*);
NI aiflib_allocated_size(void*);
void* aiflib_alloc_fixed(NI);
void aiflib_dealloc_fixed(void*);
void aiflib_arc_inc(NI*);
NB8 aiflib_arc_dec(NI*);
NB8 aiflib_arc_is_unique(NI*);
NI aiflib_icheck_b(NI, NI);
NI aiflib_icheck_ab(NI, NI, NI);
NU aiflib_ucheck_b(NU, NU);
NU aiflib_ucheck_ab(NU, NU, NU);
void aiflib_panic(Aiflib_string);
void aiflib_oom_handler(NI);
NB8 aiflib_str_eq(Aiflib_string, Aiflib_string);
NI aiflib_str_cmp(Aiflib_string, Aiflib_string);
NB8 aiflib_str_lt(Aiflib_string, Aiflib_string);
NB8 aiflib_str_le(Aiflib_string, Aiflib_string);
NI aiflib_recalc_cap(NI, NI);`;

function shimTypedefs(/* ignored: always emit the small fixed set */) {
  return STRUCTS + "\n" + GLOBALS;
}

// resolvers receive the array of call-argument *kinds* (see aiflib-cc classifyArg)
// plus the canonical {base,disamb}.  write(File, value): value is the LAST arg.
const WRITE_BY_KIND = {
  string: "aiflib_write_string", char: "aiflib_write_char",
  int: "aiflib_write_int", uint: "aiflib_write_uint",
  bool: "aiflib_write_bool", float: "aiflib_write_float",
};
// Fallback for value args whose type can't be classified from the IR (field
// accesses, calls): nimony's overload disambiguators for syncio `write(File,_)`.
// Only entries verified against the local toolchain are listed; an unlisted
// disambiguator falls through to a coverage-gap error rather than a guess.
const WRITE_BY_DISAMB = {
  "0": "aiflib_write_string", "1": "aiflib_write_bool",
  "2": "aiflib_write_int",    "7": "aiflib_write_char",
};
const writeResolve = (kinds, c) =>
  WRITE_BY_KIND[kinds[kinds.length - 1]] || (c && WRITE_BY_DISAMB[c.disamb]) || null;

// Lifecycle hook target for a given op and the (first) argument's type kind.
// Only `string` has its hooks defined in the system module and referenced as an
// *extern* here; seq hooks are monomorphised into the main module and user-type
// (ref/object) hooks are defined there too — so an extern lifecycle hook that
// reaches this table is a string hook.  When the argument type can't be read
// from the IR (e.g. a seq-element index), fall back to the string hook.
const STRING_HOOKS = {
  destroy: "aiflib_str_destroy", copy: "aiflib_str_copy",
  dup: "aiflib_str_dup", wasMoved: "aiflib_str_was_moved", sink: null,
};
function hookTarget(op, kinds) {
  const t = (kinds && kinds[0]) || "expr";
  if (t === "string" || t === "expr" || t === "none") return STRING_HOOKS[op] || null;
  return null;   // a classified non-string type must have local hooks, not these
}

const RUNTIME = {
  // --- types (aliased by name) ---
  LongString: { kind: "type", target: "LongString" },
  string:     { kind: "type", target: "string" },
  seq:        { kind: "type", target: "seq" },
  File:       { kind: "type", target: "File" },

  // --- module init ---
  ini: { kind: "proc", target: "aiflib_noop" },

  // --- io (syncio) ---
  write:              { kind: "proc", resolve: writeResolve },
  nimFlushStdStreams: { kind: "proc", target: "aiflib_flush_std_streams" },
  stdout: { kind: "global", target: "aiflib_stdout" },
  stderr: { kind: "global", target: "aiflib_stderr" },
  stdin:  { kind: "global", target: "aiflib_stdin" },

  // --- strings ---
  "&":  { kind: "proc", target: "aiflib_str_concat" },
  // string `[]`: char index (2nd arg int) -> aiflib_str_index; slice (2nd arg
  // HSlice) -> substr, emitted as an after-types wrapper (marker "@slice",
  // handled in aiflib-cc because HSlice is a module-local type).  seq/openArray
  // `[]` are monomorphised locally, never externs.
  "[]": { kind: "proc", resolve: (kinds) =>
            kinds[kinds.length - 1] === "slice" ? "@slice"
            : (kinds[0] === "string" || kinds[0] === "expr" || kinds[0] === "none")
              ? "aiflib_str_index" : null },
  "$":  { kind: "proc", resolve: (kinds) => ({ int: "aiflib_dollar_int", uint: "aiflib_dollar_uint", bool: "aiflib_dollar_bool" }[kinds[0]] || "aiflib_dollar_int") },
  add:  { kind: "proc", resolve: (kinds) => (kinds[kinds.length - 1] === "char" ? "aiflib_str_add_char" : "aiflib_str_add_str") },
  len:  { kind: "proc", target: "aiflib_str_len" },
  newString: { kind: "proc", target: "aiflib_new_string" },
  // string `[]=`(i, c): in-place char mutation (COW-safe).  Only string `[]=`
  // reaches as an extern (seq `[]=` is monomorphised locally); resolve by the
  // container arg's type so a non-string `[]=` stays a coverage gap.
  "[]=": { kind: "proc", resolve: (kinds) =>
             (kinds[0] === "string" || kinds[0] === "expr" || kinds[0] === "none")
               ? "aiflib_str_index_set" : null },
  // `for c in s` lowers to `toOpenArray(s)` returning an openArray[char]
  // ({NC8* a; NI len}).  Only the *string* toOpenArray reaches the linker as a
  // system extern (seq/array versions are monomorphised locally).  Its return
  // type is the module-local openArray struct, so aiflib-cc can't `#define` it to
  // a fixed aiflib type — it emits a real function *after* the type section
  // (kind "openarray-str", handled in aiflib-cc, no target/resolve here).
  toOpenArray: { kind: "openarray-str" },
  // string equality: only `string.==` reaches the linker as an extern (int/float
  // `==` lower to C `==` inline; enum/seq/object `==` are monomorphised locally).
  // Resolve by arg type so a non-string `==` extern surfaces as a coverage gap
  // rather than being mis-bound to the string comparator.
  "==": { kind: "proc", resolve: (kinds) =>
            (kinds[0] === "string" || kinds[0] === "expr" || kinds[0] === "none")
              ? "aiflib_str_eq" : null },
  // `case s` over strings lowers to a direct equalStrings call (not `==`).
  equalStrings: { kind: "proc", target: "aiflib_str_eq" },
  // Ordered string comparison. Like `==`, only the string overloads reach the
  // linker as externs (int/float/char `<`/`<=` lower to C operators); resolve by
  // arg type so any non-string comparator extern surfaces as a coverage gap.
  "<":  { kind: "proc", resolve: (kinds) =>
            (kinds[0] === "string" || kinds[0] === "expr" || kinds[0] === "none")
              ? "aiflib_str_lt" : null },
  "<=": { kind: "proc", resolve: (kinds) =>
            (kinds[0] === "string" || kinds[0] === "expr" || kinds[0] === "none")
              ? "aiflib_str_le" : null },
  cmp:  { kind: "proc", resolve: (kinds) =>
            (kinds[0] === "string" || kinds[0] === "expr" || kinds[0] === "none")
              ? "aiflib_str_cmp" : null },
  nimStrDestroy:  { kind: "proc", target: "aiflib_str_destroy" },
  nimStrCopy:     { kind: "proc", target: "aiflib_str_copy" },
  nimStrDup:      { kind: "proc", target: "aiflib_str_dup" },

  // --- lifecycle hooks (=destroy/=copy/=dup/=wasMoved), resolved by arg type.
  //     seq/ref hooks for user types are defined in the main module itself; only
  //     the system-provided string/seq hooks land here as externs. ---
  "=destroy":  { kind: "proc", resolve: (k, c) => hookTarget("destroy", k) },
  "=copy":     { kind: "proc", resolve: (k, c) => hookTarget("copy", k) },
  "=dup":      { kind: "proc", resolve: (k, c) => hookTarget("dup", k) },
  "=sink":     { kind: "proc", resolve: (k, c) => hookTarget("sink", k) },
  "=wasMoved": { kind: "proc", resolve: (k, c) => hookTarget("wasMoved", k) },

  // --- memory / ARC ---
  alloc:         { kind: "proc", target: "aiflib_alloc" },
  alloc0:        { kind: "proc", target: "aiflib_alloc0" },
  realloc:       { kind: "proc", target: "aiflib_realloc" },
  dealloc:       { kind: "proc", target: "aiflib_dealloc" },
  allocatedSize: { kind: "proc", target: "aiflib_allocated_size" },
  recalcCap:     { kind: "proc", target: "aiflib_recalc_cap" },
  allocFixed:    { kind: "proc", target: "aiflib_alloc_fixed" },
  deallocFixed:  { kind: "proc", target: "aiflib_dealloc_fixed" },
  arcInc:        { kind: "proc", target: "aiflib_arc_inc" },
  arcDec:        { kind: "proc", target: "aiflib_arc_dec" },
  arcIsUnique:   { kind: "proc", target: "aiflib_arc_is_unique" },

  // --- panics / checks / OOM ---
  panic:      { kind: "proc", target: "aiflib_panic" },
  nimIcheckB:  { kind: "proc", target: "aiflib_icheck_b" },
  nimIcheckAB: { kind: "proc", target: "aiflib_icheck_ab" },
  nimUcheckB:  { kind: "proc", target: "aiflib_ucheck_b" },
  nimUcheckAB: { kind: "proc", target: "aiflib_ucheck_ab" },
  oomHandler: { kind: "proc", target: "aiflib_oom_handler" },
};

module.exports = { RUNTIME, shimTypedefs, PROTOS, STRUCTS, GLOBALS };
