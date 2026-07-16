#!/usr/bin/env bash
# run.sh — build every example .c.nif natively through aiflib-cc and assert its
# runtime output matches test/expected/<name>.txt.
#
#   test/run.sh              # build from committed .c.nif (needs only node + gcc)
#   test/run.sh --regen      # first regenerate every .c.nif from its .nim (needs nimony)
#
# This is the aiflib acceptance suite: it proves real nimony programs — echo,
# strings, seqs, ref objects with ARC — link and run natively against the
# aiflib runtime with no nimony system.c.nif.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
ex="examples"; exp="test/expected"; work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

EXAMPLES=(hello echo_str echo_int concat loopsum strbuild multi
          seqlen seqsum refobj bignum longstr whilei caseof seqstr stridx
          # string comparison / equality / case-on-string
          streq strcmp casestr
          # seqs: growth (recalcCap), nesting, assignment, return-by-value
          seqadd seqnest seqassign retseq
          # objects/refs with heap-typed fields (aifc value-dep type ordering)
          refstr objseq
          # string iteration (for c in s -> toOpenArray) and slicing (substr)
          foriter strslice
          # case objects (variant records -> anonymous C11 union)
          objvariant
          # bounds checks: array OOB panic, non-zero-based array (nimIcheckAB)
          arroob arrab
          # integer extremes and SSO string tier boundaries
          intmin ssobound)

if [ "${1:-}" = "--regen" ]; then
  echo "== regenerating .c.nif from .nim =="
  for f in "${EXAMPLES[@]}"; do
    [ -f "$ex/$f.nim" ] || continue
    test/gen-cnif.sh "$ex/$f.nim" "$ex/$f.c.nif" >/dev/null 2>&1 \
      && echo "  regen $f" || echo "  SKIP  $f (gen failed)"
  done
fi

pass=0; fail=0; failed=()
for f in "${EXAMPLES[@]}"; do
  out="$work/$f"
  if ! node bin/aiflib-cc.js "$ex/$f.c.nif" -o "$out" >"$work/$f.err" 2>&1; then
    echo "  FAIL  $f (build)"; sed 's/^/        /' "$work/$f.err" | head -4
    fail=$((fail+1)); failed+=("$f"); continue
  fi
  got="$("$out" 2>&1)"; want="$(cat "$exp/$f.txt")"
  if [ "$got" = "$want" ]; then
    printf '  ok    %-10s %s\n' "$f" "$(echo "$got" | head -1)"
    pass=$((pass+1))
  else
    echo "  FAIL  $f (output)"; echo "        want: $(echo "$want" | head -3 | tr '\n' '|')"
    echo "        got:  $(echo "$got" | head -3 | tr '\n' '|')"
    fail=$((fail+1)); failed+=("$f")
  fi
done

echo
echo "$pass/$((pass+fail)) passed"
[ "$fail" -eq 0 ] || { echo "failed: ${failed[*]}"; exit 1; }
