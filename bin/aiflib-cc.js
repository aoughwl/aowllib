#!/usr/bin/env node
/* aiflib-cc — link a post-hexer `.c.nif` into a native binary against aiflib.
 *
 *   aiflib-cc <module.c.nif> [-o out] [--emit-c file.c] [--cc gcc] [--run]
 *
 * Pipeline:
 *   1. print the module to C with aifc (compileModule, no extern stubs)
 *   2. scan the `.c.nif` for undefined runtime externs (symbols carrying a
 *      module hash and not defined in this module)
 *   3. map each onto an aiflib canonical symbol via RUNTIME (docs/runtime.md);
 *      any unmapped runtime symbol is a hard error listing the gap
 *   4. inject a shim (types + aliases) right after aifc's PRELUDE
 *   5. compile + link with the aiflib runtime -> native binary
 *
 * aiflib is the self-owned `system`/`syncio` layer, so only the *main* module's
 * `.c.nif` is compiled; system/syncio come from the C runtime, not their own
 * `.c.nif`.  See https://github.com/aoughwl/aiflib.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const AIFC = process.env.AIFLIB_AIFC ||
  [path.join(process.env.HOME || "", "aifc", "nifc.js"),
   path.join(__dirname, "..", "..", "aifc", "nifc.js")].find(p => fs.existsSync(p));
if (!AIFC) { console.error("aiflib-cc: cannot find aifc (nifc.js); set AIFLIB_AIFC"); process.exit(2); }
const api = require(AIFC);
const RUNTIME_DIR = path.join(__dirname, "..", "runtime");
const { RUNTIME, shimTypedefs } = require(path.join(RUNTIME_DIR, "runtime-map.js"));

// ---- extern collection ----------------------------------------------------
// A cross-module symbol reference is an atom `base.disamb.hash` with a NONEMPTY
// hash. This module's own symbols carry an empty hash (`base.disamb.`).
const EXTERN_RE = /^`?[^\s()]+\.\d+\.[A-Za-z0-9]{4,}$/;

const deEsc = (s) => s.replace(/\\([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

function canon(sym) {                       // `write.7.syn1lfpjv` -> {base,disamb}
  const s = sym.replace(/^`/, "");
  const m = s.match(/^(.+)\.(\d+)\.[A-Za-z0-9]{4,}$/);
  if (!m) return null;
  // base may be NIF-escaped (e.g. `\5B\5D` for `[]`); expose a readable form too.
  return { base: m[1], baseReadable: deEsc(m[1]), disamb: m[2], full: sym };
}

function collectExterns(nodes) {
  const found = new Map();                  // full-sym -> {sym, args}
  function walk(node, callArgs) {
    if (!node) return;
    if (node.atom !== undefined) {
      if (EXTERN_RE.test(node.atom)) {
        if (!found.has(node.atom)) found.set(node.atom, { sym: node.atom, args: callArgs || [] });
      }
      return;
    }
    if (node.kids) {
      const isCall = node.tag === "call" || node.tag === "hcall";
      const args = isCall ? node.kids.slice(1) : null;   // args to THIS call's callee
      node.kids.forEach((k, i) => {
        // first kid of a call is the callee: hand it the call's arg list
        walk(k, isCall && i === 0 ? args : null);
      });
    }
  }
  nodes.forEach(n => walk(n, null));
  return found;
}

// ---- overload resolution --------------------------------------------------
// Build a symbol table (sym -> declared type node) so we can classify variable
// arguments, not just literals.  Covers top-level & nested decls and params.
const DECL_TAGS = new Set(["gvar", "tvar", "glet", "let", "var", "const"]);
function buildSymtab(nodes) {
  const tab = new Map();
  function walk(node) {
    if (!node || !node.kids) return;
    if (DECL_TAGS.has(node.tag) && node.kids[0] && node.kids[0].def) {
      tab.set(node.kids[0].atom, node.kids[2] || null);     // name -> type node
    } else if (node.tag === "param" && node.kids[0] && node.kids[0].def) {
      // (param :name <pragmas> <type>) — type is the last kid
      tab.set(node.kids[0].atom, node.kids[node.kids.length - 1] || null);
    }
    node.kids.forEach(walk);
  }
  nodes.forEach(walk);
  return tab;
}

// Classify a type node -> overload kind.
function typeKind(t) {
  if (!t) return "expr";
  if (t.atom !== undefined) {
    if (/^string\./.test(t.atom)) return "string";
    if (/^cstring/.test(t.atom)) return "cstring";
    if (/^HSlice\./.test(t.atom)) return "slice";
    return "expr";
  }
  switch (t.tag) {
    case "i": return "int";
    case "u": return "uint";
    case "f": return "float";
    case "c": return "char";
    case "bool": case "true": case "false": return "bool";
    default: return "expr";
  }
}

// Classify a call-argument node -> overload kind, using literal shape, the
// symbol table, and the type carried by typed expression nodes.
function classifyArg(arg, symtab) {
  if (!arg) return "none";
  if (arg.chr !== undefined) return "char";
  if (arg.str !== undefined) return "string";
  if (arg.tag === "true" || arg.tag === "false") return "bool";
  if (arg.atom !== undefined) {
    if (/^-?\d+u/.test(arg.atom)) return "uint";
    if (/^-?\d+$/.test(arg.atom)) return "int";
    if (/^-?[\d.]+[fd]?$/.test(arg.atom) && arg.atom.includes(".")) return "float";
    if (symtab.has(arg.atom)) return typeKind(symtab.get(arg.atom));  // variable
    return "expr";
  }
  if (arg.kids) {
    if (arg.tag === "oconstr") {
      const t = arg.kids[0] && arg.kids[0].atom;
      if (t && /^(string|LongString)\./.test(t)) return "string";
    }
    if (arg.tag === "suf") {                // typed literal suffix, e.g. (suf 10 +i)
      const suf = arg.kids[1] && arg.kids[1].atom;
      if (suf === "+c") return "char";
      if (suf && /^\+i/.test(suf)) return "int";
      if (suf && /^\+u/.test(suf)) return "uint";
      if (suf && /^\+f/.test(suf)) return "float";
    }
    // typed expression: many hexer nodes are (op TYPE args...)
    const k = typeKind(arg.kids[0]);
    if (k !== "expr") return k;
  }
  return "expr";
}

// ---- main -----------------------------------------------------------------
function parseArgs(argv) {
  const o = { cc: process.env.CC || "gcc", run: false, cflags: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o") o.out = argv[++i];
    else if (a === "--emit-c") o.emitC = argv[++i];
    else if (a === "--cc") o.cc = argv[++i];
    else if (a === "--run") o.run = true;
    else if (a === "--cflags") o.cflags.push(...argv[++i].split(/\s+/));
    else if (!o.input) o.input = a;
    else o.cflags.push(a);
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.input) {
    console.error("usage: aiflib-cc <module.c.nif> [-o out] [--emit-c f.c] [--run]");
    process.exit(2);
  }
  const snif = fs.readFileSync(o.input, "utf8");
  const nodes = api.readNif(snif);
  const userC = api.compileModule(snif, { stubExterns: false });

  // collect + resolve externs
  const symtab = buildSymtab(nodes);
  const externs = collectExterns(nodes);
  const shimLines = [];
  const typedefsNeeded = new Set();
  const unmapped = [];
  const openArrayStrSyms = [];   // mangled names of string toOpenArray externs
  const sliceStrSyms = [];       // mangled names of string []-with-HSlice (substr) externs
  for (const [sym, info] of externs) {
    const c = canon(sym);
    if (!c) continue;
    const cName = api.mangleToC(sym);
    const entry = RUNTIME[c.base] || RUNTIME[c.baseReadable];
    if (!entry) { unmapped.push(`${sym}  (base '${c.base}')`); continue; }
    if (entry.kind === "openarray-str") {
      // string `toOpenArray`: defined as a real function after the types (below),
      // because its return type is the module-local openArray struct.
      openArrayStrSyms.push(cName);
      continue;
    }
    let target;
    if (typeof entry.resolve === "function") target = entry.resolve(info.args.map(a => classifyArg(a, symtab)), c);
    else target = entry.target;
    if (target === "@slice") {
      // string `[]`(HSlice): substr wrapper emitted after the types (below),
      // because the HSlice parameter type is module-local.
      sliceStrSyms.push(cName);
      continue;
    }
    if (!target) { unmapped.push(`${sym}  (unresolved overload for base '${c.base}')`); continue; }
    if (entry.typedefs) entry.typedefs.forEach(t => typedefsNeeded.add(t));
    if (entry.kind === "type") {
      // the type itself is aliased by name to an aiflib canonical struct
      typedefsNeeded.add(target);
      shimLines.push(`typedef Aiflib_${target} ${cName};`);
    } else {
      shimLines.push(`#define ${cName} ${target}`);
    }
  }
  if (unmapped.length) {
    console.error("aiflib-cc: unmapped runtime symbols (aiflib coverage gap):\n  " +
      unmapped.join("\n  ") + "\nAdd them to runtime/runtime-map.js + runtime/aiflib.{h,c}.");
    process.exit(3);
  }

  const shim = "/* ---- aiflib shim (generated) ---- */\n" +
    shimTypedefs([...typedefsNeeded]) + "\n" +
    "/* runtime prototypes */\n" + require(path.join(RUNTIME_DIR, "runtime-map.js")).PROTOS + "\n" +
    shimLines.join("\n") + "\n";

  let finalC = userC.replace(api.PRELUDE, api.PRELUDE + "\n" + shim);

  // String `toOpenArray`: emit a real function after the type section (where the
  // module-local openArray[char] struct is complete).  It returns {data,len} of
  // the string — matching nimony's openArray layout {NC8* a; NI len}.
  if (openArrayStrSyms.length) {
    const m = finalC.match(
      /typedef struct (openArray_\w+) \{\s*NC8\s*\*\s*(\w+)\s*;\s*NI64\s+(\w+)\s*;\s*\}/);
    if (!m) {
      console.error("aiflib-cc: string toOpenArray referenced but no openArray[char] " +
        "type ({NC8* a; NI64 len}) found in the module — cannot bind it.");
      process.exit(3);
    }
    const [, oaType, dataFld, lenFld] = m;
    const helpers = openArrayStrSyms.map((nm) =>
      `static inline ${oaType} ${nm}(Aiflib_string* aiflib_sp) {\n` +
      `  ${oaType} aiflib_oa;\n` +
      `  aiflib_oa.${dataFld} = (NC8*)aiflib_str_data(aiflib_sp);\n` +
      `  aiflib_oa.${lenFld} = aiflib_str_len(*aiflib_sp);\n` +
      `  return aiflib_oa;\n}`).join("\n");
    const block = "/* ---- aiflib string toOpenArray (generated, after types) ---- */\n" +
      helpers + "\n\n";
    const anchor = ["/* --- prototypes --- */", "/* --- procedures --- */"]
      .find((a) => finalC.includes(a));
    if (!anchor) {
      console.error("aiflib-cc: could not find an injection anchor after the type section.");
      process.exit(3);
    }
    finalC = finalC.replace(anchor, block + anchor);
  }

  // String `[]`(HSlice) substr: like toOpenArray, its HSlice parameter type is
  // module-local, so emit a real wrapper after the types that decomposes the
  // HSlice ({a,b}) and calls the fixed aiflib substr entry point.
  if (sliceStrSyms.length) {
    const st = finalC.match(/typedef struct (string_\w+)\b/) ||
               [null, "Aiflib_string"];
    const hs = finalC.match(
      /typedef struct (HSlice_\w+) \{\s*NI64\s+(\w+)\s*;\s*NI64\s+(\w+)\s*;\s*\}/);
    if (!hs) {
      console.error("aiflib-cc: string slice referenced but no HSlice[int,int] type " +
        "({NI64 a; NI64 b}) found in the module — cannot bind it.");
      process.exit(3);
    }
    const strType = st[1], [, hsType, aFld, bFld] = hs;
    const helpers = sliceStrSyms.map((nm) =>
      `static inline ${strType} ${nm}(${strType} aiflib_s, ${hsType} aiflib_x) {\n` +
      `  return aiflib_str_slice_ab(aiflib_s, aiflib_x.${aFld}, aiflib_x.${bFld});\n}`).join("\n");
    const block = "/* ---- aiflib string slice / substr (generated, after types) ---- */\n" +
      helpers + "\n\n";
    const anchor = ["/* --- prototypes --- */", "/* --- procedures --- */"]
      .find((a) => finalC.includes(a));
    if (!anchor) {
      console.error("aiflib-cc: could not find an injection anchor after the type section.");
      process.exit(3);
    }
    finalC = finalC.replace(anchor, block + anchor);
  }

  const cFile = o.emitC || path.join(require("os").tmpdir(), "aiflib_" + path.basename(o.input) + ".c");
  fs.writeFileSync(cFile, finalC);
  if (o.emitC && !o.out) { console.log("wrote " + cFile); return; }

  const out = o.out || o.input.replace(/\.c\.nif$/, "").replace(/\.nif$/, "") || "a.out";
  // -w silences aifc's stylistic warnings, but an implicit function declaration
  // is a real defect for us: a runtime function called without a prototype is
  // assumed to return int, which silently truncates 64-bit returns (pointers!).
  // Promote exactly that class back to a hard error.
  const cmd = [o.cc, "-std=gnu11", "-O2", "-w",
    "-Werror=implicit-function-declaration", "-Werror=implicit-int", cFile,
    path.join(RUNTIME_DIR, "aiflib.c"), "-I", RUNTIME_DIR, "-o", out, ...o.cflags];
  const r = cp.spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
  if (r.status !== 0) { console.error("aiflib-cc: cc failed"); process.exit(r.status || 1); }
  if (o.run) {
    const rr = cp.spawnSync(path.resolve(out), [], { stdio: "inherit" });
    process.exit(rr.status || 0);
  }
}

main();
