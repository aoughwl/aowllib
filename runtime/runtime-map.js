/* runtime-map.js — maps nimony `system`/`syncio` symbols onto aowllib canonical
 * entry points, and supplies the C the generated shim injects.
 *
 * Keyed by the symbol *base* (the name before `.disamb.hash`).  Overloaded
 * bases (`write`) carry a `resolve(argKind, canon)` that picks the target from
 * the call-site argument.  A referenced base with no entry here is reported by
 * aowllib-cc as a coverage gap.  Keep this table in lock-step with aowllib.{h,c}.
 */
"use strict";

// Canonical aowllib struct definitions the shim injects (field names are the
// hash-independent nimony mangled names, so aowlc's printed field accesses hit).
const STRUCTS = `typedef struct { NI fullLen_0; NI rc_0; NI capImpl_0; NC8* data_0; } Aowllib_LongString;
typedef struct { NU bytes_0; Aowllib_LongString* more_0; } Aowllib_string;
typedef struct { NI len_0; void* data_0; } Aowllib_seq;
typedef struct { NI fd; NU flags; } Aowllib_File;
typedef struct Aowllib_Rtti { NI dl_0; NU32* dy_0; void* mt_0[256]; } Aowllib_Rtti;
typedef struct { const struct Aowllib_Rtti* vt_00; } Aowllib_RootObj;`;

// Externs the shim declares (std handles, always safe to declare).
const GLOBALS = `extern Aowllib_File aowllib_stdout;
extern Aowllib_File aowllib_stderr;
extern Aowllib_File aowllib_stdin;`;

// Prototypes for every aowllib runtime function the shim may alias to.
const PROTOS = `NI aowllib_str_len(Aowllib_string);
const NC8* aowllib_str_data(const Aowllib_string*);
void aowllib_write_string(Aowllib_File, Aowllib_string);
void aowllib_write_char(Aowllib_File, NC8);
void aowllib_write_int(Aowllib_File, NI64);
void aowllib_write_uint(Aowllib_File, NU64);
void aowllib_write_bool(Aowllib_File, NB8);
void aowllib_write_float(Aowllib_File, NF64);
void aowllib_flush_std_streams(void);
void aowllib_noop(void);
Aowllib_string aowllib_str_concat(Aowllib_string, Aowllib_string);
Aowllib_string aowllib_str_slice_ab(Aowllib_string, NI, NI);
NC8 aowllib_str_index(Aowllib_string, NI);
void aowllib_str_index_set(Aowllib_string*, NI, NC8);
Aowllib_string aowllib_new_string(NI);
void aowllib_str_add_char(Aowllib_string*, NC8);
void aowllib_str_add_str(Aowllib_string*, Aowllib_string);
Aowllib_string aowllib_dollar_int(NI64);
Aowllib_string aowllib_dollar_uint(NU64);
Aowllib_string aowllib_dollar_bool(NB8);
void aowllib_str_destroy(Aowllib_string);
void aowllib_str_copy(Aowllib_string*, Aowllib_string);
Aowllib_string aowllib_str_dup(Aowllib_string);
void aowllib_str_was_moved(Aowllib_string*);
void* aowllib_alloc(NI);
void* aowllib_alloc0(NI);
void* aowllib_realloc(void*, NI);
void aowllib_dealloc(void*);
NI aowllib_allocated_size(void*);
void* aowllib_alloc_fixed(NI);
void aowllib_dealloc_fixed(void*);
void aowllib_arc_inc(NI*);
NB8 aowllib_arc_dec(NI*);
NB8 aowllib_arc_is_unique(NI*);
NI aowllib_icheck_b(NI, NI);
NI aowllib_icheck_ab(NI, NI, NI);
NU aowllib_ucheck_b(NU, NU);
NU aowllib_ucheck_ab(NU, NU, NU);
void aowllib_panic(Aowllib_string);
void aowllib_oom_handler(NI);
void aowllib_chck_nil_disp(const void*);
NB8 aowllib_str_eq(Aowllib_string, Aowllib_string);
NI aowllib_str_cmp(Aowllib_string, Aowllib_string);
NB8 aowllib_str_lt(Aowllib_string, Aowllib_string);
NB8 aowllib_str_le(Aowllib_string, Aowllib_string);
NI aowllib_recalc_cap(NI, NI);`;

function shimTypedefs(/* ignored: always emit the small fixed set */) {
  return STRUCTS + "\n" + GLOBALS;
}

// resolvers receive the array of call-argument *kinds* (see aowllib-cc classifyArg)
// plus the canonical {base,disamb}.  write(File, value): value is the LAST arg.
const WRITE_BY_KIND = {
  string: "aowllib_write_string", char: "aowllib_write_char",
  int: "aowllib_write_int", uint: "aowllib_write_uint",
  bool: "aowllib_write_bool", float: "aowllib_write_float",
};
// Fallback for value args whose type can't be classified from the IR (field
// accesses, calls): nimony's overload disambiguators for syncio `write(File,_)`.
// Only entries verified against the local toolchain are listed; an unlisted
// disambiguator falls through to a coverage-gap error rather than a guess.
const WRITE_BY_DISAMB = {
  "0": "aowllib_write_string", "1": "aowllib_write_bool",
  "2": "aowllib_write_int",    "7": "aowllib_write_char",
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
  destroy: "aowllib_str_destroy", copy: "aowllib_str_copy",
  dup: "aowllib_str_dup", wasMoved: "aowllib_str_was_moved", sink: null,
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
  // inheritance / RTTI: RootObj is the inheritable base (carries the hidden
  // type-info pointer); Rtti is the per-type vtable (`{depth, display, methods}`).
  // Both come from the system module, so a program using `object of RootObj`
  // references them as externs; aowllib provides the layouts.
  RootObj:    { kind: "type", target: "RootObj" },
  Rtti:       { kind: "type", target: "Rtti" },

  // --- module init ---
  ini: { kind: "proc", target: "aowllib_noop" },

  // --- io (syncio) ---
  write:              { kind: "proc", resolve: writeResolve },
  nimFlushStdStreams: { kind: "proc", target: "aowllib_flush_std_streams" },
  stdout: { kind: "global", target: "aowllib_stdout" },
  stderr: { kind: "global", target: "aowllib_stderr" },
  stdin:  { kind: "global", target: "aowllib_stdin" },

  // --- strings ---
  "&":  { kind: "proc", target: "aowllib_str_concat" },
  // string `[]`: char index (2nd arg int) -> aowllib_str_index; slice (2nd arg
  // HSlice) -> substr, emitted as an after-types wrapper (marker "@slice",
  // handled in aowllib-cc because HSlice is a module-local type).  seq/openArray
  // `[]` are monomorphised locally, never externs.
  "[]": { kind: "proc", resolve: (kinds) =>
            kinds[kinds.length - 1] === "slice" ? "@slice"
            : (kinds[0] === "string" || kinds[0] === "expr" || kinds[0] === "none")
              ? "aowllib_str_index" : null },
  "$":  { kind: "proc", resolve: (kinds) => ({ int: "aowllib_dollar_int", uint: "aowllib_dollar_uint", bool: "aowllib_dollar_bool" }[kinds[0]] || "aowllib_dollar_int") },
  add:  { kind: "proc", resolve: (kinds) => (kinds[kinds.length - 1] === "char" ? "aowllib_str_add_char" : "aowllib_str_add_str") },
  len:  { kind: "proc", target: "aowllib_str_len" },
  newString: { kind: "proc", target: "aowllib_new_string" },
  // string `[]=`(i, c): in-place char mutation (COW-safe).  Only string `[]=`
  // reaches as an extern (seq `[]=` is monomorphised locally); resolve by the
  // container arg's type so a non-string `[]=` stays a coverage gap.
  "[]=": { kind: "proc", resolve: (kinds) =>
             (kinds[0] === "string" || kinds[0] === "expr" || kinds[0] === "none")
               ? "aowllib_str_index_set" : null },
  // `for c in s` lowers to `toOpenArray(s)` returning an openArray[char]
  // ({NC8* a; NI len}).  Only the *string* toOpenArray reaches the linker as a
  // system extern (seq/array versions are monomorphised locally).  Its return
  // type is the module-local openArray struct, so aowllib-cc can't `#define` it to
  // a fixed aowllib type — it emits a real function *after* the type section
  // (kind "openarray-str", handled in aowllib-cc, no target/resolve here).
  toOpenArray: { kind: "openarray-str" },
  // string equality: only `string.==` reaches the linker as an extern (int/float
  // `==` lower to C `==` inline; enum/seq/object `==` are monomorphised locally).
  // Resolve by arg type so a non-string `==` extern surfaces as a coverage gap
  // rather than being mis-bound to the string comparator.
  "==": { kind: "proc", resolve: (kinds) =>
            (kinds[0] === "string" || kinds[0] === "expr" || kinds[0] === "none")
              ? "aowllib_str_eq" : null },
  // `case s` over strings lowers to a direct equalStrings call (not `==`).
  equalStrings: { kind: "proc", target: "aowllib_str_eq" },
  // Ordered string comparison. Like `==`, only the string overloads reach the
  // linker as externs (int/float/char `<`/`<=` lower to C operators); resolve by
  // arg type so any non-string comparator extern surfaces as a coverage gap.
  "<":  { kind: "proc", resolve: (kinds) =>
            (kinds[0] === "string" || kinds[0] === "expr" || kinds[0] === "none")
              ? "aowllib_str_lt" : null },
  "<=": { kind: "proc", resolve: (kinds) =>
            (kinds[0] === "string" || kinds[0] === "expr" || kinds[0] === "none")
              ? "aowllib_str_le" : null },
  cmp:  { kind: "proc", resolve: (kinds) =>
            (kinds[0] === "string" || kinds[0] === "expr" || kinds[0] === "none")
              ? "aowllib_str_cmp" : null },
  nimStrDestroy:  { kind: "proc", target: "aowllib_str_destroy" },
  nimStrCopy:     { kind: "proc", target: "aowllib_str_copy" },
  nimStrDup:      { kind: "proc", target: "aowllib_str_dup" },

  // --- lifecycle hooks (=destroy/=copy/=dup/=wasMoved), resolved by arg type.
  //     seq/ref hooks for user types are defined in the main module itself; only
  //     the system-provided string/seq hooks land here as externs. ---
  "=destroy":  { kind: "proc", resolve: (k, c) => hookTarget("destroy", k) },
  "=copy":     { kind: "proc", resolve: (k, c) => hookTarget("copy", k) },
  "=dup":      { kind: "proc", resolve: (k, c) => hookTarget("dup", k) },
  "=sink":     { kind: "proc", resolve: (k, c) => hookTarget("sink", k) },
  "=wasMoved": { kind: "proc", resolve: (k, c) => hookTarget("wasMoved", k) },

  // --- memory / ARC ---
  alloc:         { kind: "proc", target: "aowllib_alloc" },
  alloc0:        { kind: "proc", target: "aowllib_alloc0" },
  realloc:       { kind: "proc", target: "aowllib_realloc" },
  dealloc:       { kind: "proc", target: "aowllib_dealloc" },
  allocatedSize: { kind: "proc", target: "aowllib_allocated_size" },
  recalcCap:     { kind: "proc", target: "aowllib_recalc_cap" },
  allocFixed:    { kind: "proc", target: "aowllib_alloc_fixed" },
  deallocFixed:  { kind: "proc", target: "aowllib_dealloc_fixed" },
  arcInc:        { kind: "proc", target: "aowllib_arc_inc" },
  arcDec:        { kind: "proc", target: "aowllib_arc_dec" },
  arcIsUnique:   { kind: "proc", target: "aowllib_arc_is_unique" },

  // --- panics / checks / OOM ---
  panic:      { kind: "proc", target: "aowllib_panic" },
  nimIcheckB:  { kind: "proc", target: "aowllib_icheck_b" },
  nimIcheckAB: { kind: "proc", target: "aowllib_icheck_ab" },
  nimUcheckB:  { kind: "proc", target: "aowllib_ucheck_b" },
  nimUcheckAB: { kind: "proc", target: "aowllib_ucheck_ab" },
  oomHandler: { kind: "proc", target: "aowllib_oom_handler" },
  nimChckNilDisp: { kind: "proc", target: "aowllib_chck_nil_disp" },
};

module.exports = { RUNTIME, shimTypedefs, PROTOS, STRUCTS, GLOBALS };
