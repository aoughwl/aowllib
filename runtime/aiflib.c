/* aiflib.c — implementation of the aowl system runtime (see aiflib.h).
 *
 * Single-threaded model: ARC counts are plain int ops (no atomics).  The seed
 * allocator is libc malloc; `allocatedSize` uses malloc_usable_size so seq
 * capacity math matches nimony's `allocatedSize`-derived capacity.
 */
#include "aiflib.h"

#include <stdlib.h>
#include <string.h>
#include <stdio.h>    /* snprintf */
#include <unistd.h>   /* write(2) */
#if defined(__GLIBC__) || defined(__linux__)
#  include <malloc.h> /* malloc_usable_size */
#  define AIFLIB_USABLE(p) malloc_usable_size(p)
#else
#  define AIFLIB_USABLE(p) ((size_t)0)
#endif

/* Standard handles (raw fds, nimNativeIo model). */
Aiflib_File aiflib_stdout = { 1, 0 };
Aiflib_File aiflib_stderr = { 2, 0 };
Aiflib_File aiflib_stdin  = { 0, 0 };

/* ======================================================================== */
/* memory / ARC                                                             */
/* ======================================================================== */

void* aiflib_alloc(NI size)          { return malloc(size ? (size_t)size : 1); }
void* aiflib_alloc0(NI size)         { return calloc(1, size ? (size_t)size : 1); }
void* aiflib_realloc(void* p, NI sz) { return realloc(p, sz ? (size_t)sz : 1); }
void  aiflib_dealloc(void* p)        { free(p); }
NI    aiflib_allocated_size(void* p) { return p ? (NI)AIFLIB_USABLE(p) : 0; }
void* aiflib_alloc_fixed(NI size)    { return aiflib_alloc(size); }
void  aiflib_dealloc_fixed(void* p)  { free(p); }

/* nimony ARC convention: rc stores (refcount-1); 0 == unique.
 *   arcInc: ++rc
 *   arcDec: if rc==0 -> true (free); else --rc, false
 *   arcIsUnique: rc==0 */
void aiflib_arc_inc(NI* rc) { (*rc)++; }
NB8  aiflib_arc_dec(NI* rc) { if (*rc == 0) return true; (*rc)--; return false; }
NB8  aiflib_arc_is_unique(NI* rc) { return *rc == 0; }

/* ======================================================================== */
/* strings                                                                  */
/* ======================================================================== */

static Aiflib_LongString* aiflib_longstr_new(const NC8* p, NI n);

static unsigned aiflib_slen(const Aiflib_string* s) {
  return (unsigned)(s->bytes_0 & 0xFFu);
}

NI aiflib_str_len(Aiflib_string s) {
  unsigned slen = aiflib_slen(&s);
  if ((int)slen > AIFLIB_PAYLOAD_SIZE) return s.more_0->fullLen_0;
  return (NI)slen;
}

const NC8* aiflib_str_data(const Aiflib_string* s) {
  unsigned slen = aiflib_slen(s);
  if ((int)slen > AIFLIB_PAYLOAD_SIZE) return &s->more_0->data_0[0];
  return (const NC8*)((const char*)&s->bytes_0 + 1);
}

/* Build a fresh string from raw bytes: inline when it fits, else a heap
 * LongString (slen == HeapSlen, rc == 0 == unique). */
Aiflib_string aiflib_str_from_bytes(const NC8* p, NI n) {
  Aiflib_string s;
  s.bytes_0 = 0;
  s.more_0 = NULL;
  if (n <= AIFLIB_PAYLOAD_SIZE) {
    ((unsigned char*)&s.bytes_0)[0] = (unsigned char)n;   /* slen */
    if (n > 0) memcpy((char*)&s.bytes_0 + 1, p, (size_t)n);
  } else {
    s.more_0 = aiflib_longstr_new(p, n);
    ((unsigned char*)&s.bytes_0)[0] = AIFLIB_HEAP_SLEN;
  }
  return s;
}

/* Allocate a heap LongString in a single block: header + data + NUL, with
 * data_0 pointing just past the header so dealloc(header) frees everything. */
static Aiflib_LongString* aiflib_longstr_new(const NC8* p, NI n) {
  Aiflib_LongString* h =
    (Aiflib_LongString*)aiflib_alloc((NI)sizeof(Aiflib_LongString) + n + 1);
  h->fullLen_0 = n;
  h->rc_0 = 0;
  h->capImpl_0 = n;
  h->data_0 = (NC8*)((char*)h + sizeof(Aiflib_LongString));
  if (p && n > 0) memcpy(h->data_0, p, (size_t)n);
  h->data_0[n] = 0;
  return h;
}

NC8 aiflib_str_index(Aiflib_string s, NI i) {
  return aiflib_str_data(&s)[i];   /* nimony emits the bounds check at the call site */
}

/* newString(n): a fresh, zero-filled string of length n (mirrors
 * system/stringimpl.nim newString). */
Aiflib_string aiflib_new_string(NI n) {
  Aiflib_string s; s.bytes_0 = 0; s.more_0 = NULL;
  if (n <= 0) return s;
  if (n <= AIFLIB_PAYLOAD_SIZE) {
    ((unsigned char*)&s.bytes_0)[0] = (unsigned char)n;
    memset((char*)&s.bytes_0 + 1, 0, (size_t)n);
  } else {
    Aiflib_LongString* h = aiflib_longstr_new(NULL, n);   /* header + data + NUL, unshared */
    memset(h->data_0, 0, (size_t)n);
    s.more_0 = h;
    ((unsigned char*)&s.bytes_0)[0] = AIFLIB_HEAP_SLEN;
  }
  return s;
}

/* prepareMutation: ensure s owns its data uniquely before an in-place write
 * (mirrors system/stringimpl.nim).  Short/medium strings are always unique
 * inline; a static (literal) or shared heap string is copied into a fresh
 * unique heap block. */
static void aiflib_str_prepare_mutation(Aiflib_string* s) {
  unsigned sl = aiflib_slen(s);
  if (sl == AIFLIB_STATIC_SLEN ||
      (sl == AIFLIB_HEAP_SLEN && !aiflib_arc_is_unique(&s->more_0->rc_0))) {
    Aiflib_LongString* old = s->more_0;
    if (sl == AIFLIB_HEAP_SLEN) aiflib_arc_dec(&old->rc_0);   /* drop our shared ref */
    s->more_0 = aiflib_longstr_new(old->data_0, old->fullLen_0);
    ((unsigned char*)&s->bytes_0)[0] = AIFLIB_HEAP_SLEN;
  }
}

/* []=(s, i, c): mutate the char at index i (bounds check emitted at call site).
 * COW-safe: a shared/static string is privatised first. */
void aiflib_str_index_set(Aiflib_string* s, NI i, NC8 c) {
  aiflib_str_prepare_mutation(s);
  ((NC8*)aiflib_str_data(s))[i] = c;
}

/* Byte equality (mirrors system/stringimpl.nim equalStrings, tier-independent:
 * equal length and equal bytes).  Empty strings compare equal. */
NB8 aiflib_str_eq(Aiflib_string a, Aiflib_string b) {
  NI la = aiflib_str_len(a), lb = aiflib_str_len(b);
  if (la != lb) return false;
  if (la == 0) return true;
  return memcmp(aiflib_str_data(&a), aiflib_str_data(&b), (size_t)la) == 0;
}

/* Lexicographic comparison (mirrors system/stringimpl.nim cmp): unsigned-byte
 * compare over the common prefix, then shorter < longer.  Returns <0/0/>0. */
NI aiflib_str_cmp(Aiflib_string a, Aiflib_string b) {
  NI la = aiflib_str_len(a), lb = aiflib_str_len(b);
  NI m = la < lb ? la : lb;
  int r = m ? memcmp(aiflib_str_data(&a), aiflib_str_data(&b), (size_t)m) : 0;
  if (r != 0) return r < 0 ? -1 : 1;   /* memcmp already compares as unsigned char */
  return la < lb ? -1 : (la > lb ? 1 : 0);
}
NB8 aiflib_str_lt(Aiflib_string a, Aiflib_string b) { return aiflib_str_cmp(a, b) <  0; }
NB8 aiflib_str_le(Aiflib_string a, Aiflib_string b) { return aiflib_str_cmp(a, b) <= 0; }

/* substr for the inclusive range first..last (mirrors system/stringimpl.nim
 * substr): first clamps up to 0, last down to high(s); empty range -> "".
 * Always a fresh string. */
Aiflib_string aiflib_str_slice_ab(Aiflib_string s, NI first, NI last) {
  NI sLen = aiflib_str_len(s);
  NI f = first < 0 ? 0 : first;
  NI l = (last < sLen - 1 ? last : sLen - 1) + 1;
  if (l <= f) return aiflib_str_from_bytes(NULL, 0);
  return aiflib_str_from_bytes(aiflib_str_data(&s) + f, l - f);
}

Aiflib_string aiflib_str_concat(Aiflib_string a, Aiflib_string b) {
  NI la = aiflib_str_len(a), lb = aiflib_str_len(b);
  NI n = la + lb;
  if (n <= AIFLIB_PAYLOAD_SIZE) {
    Aiflib_string s; s.bytes_0 = 0; s.more_0 = NULL;
    ((unsigned char*)&s.bytes_0)[0] = (unsigned char)n;
    char* dst = (char*)&s.bytes_0 + 1;
    if (la) memcpy(dst, aiflib_str_data(&a), (size_t)la);
    if (lb) memcpy(dst + la, aiflib_str_data(&b), (size_t)lb);
    return s;
  }
  Aiflib_LongString* h = aiflib_longstr_new(NULL, n);
  if (la) memcpy(h->data_0, aiflib_str_data(&a), (size_t)la);
  if (lb) memcpy(h->data_0 + la, aiflib_str_data(&b), (size_t)lb);
  h->data_0[n] = 0;
  Aiflib_string s; s.bytes_0 = 0; s.more_0 = h;
  ((unsigned char*)&s.bytes_0)[0] = AIFLIB_HEAP_SLEN;
  return s;
}

void aiflib_str_add_str(Aiflib_string* s, Aiflib_string part) {
  Aiflib_string r = aiflib_str_concat(*s, part);
  aiflib_str_destroy(*s);
  *s = r;
}

void aiflib_str_add_char(Aiflib_string* s, NC8 c) {
  Aiflib_string one = aiflib_str_from_bytes(&c, 1);
  aiflib_str_add_str(s, one);
}

void aiflib_str_destroy(Aiflib_string s) {
  if (aiflib_slen(&s) == AIFLIB_HEAP_SLEN && s.more_0) {
    if (aiflib_arc_dec(&s.more_0->rc_0)) aiflib_dealloc(s.more_0);
  }
}

void aiflib_str_copy(Aiflib_string* dest, Aiflib_string src) {
  unsigned ss = aiflib_slen(&src);
  if (aiflib_slen(dest) == AIFLIB_HEAP_SLEN && dest->more_0)
    if (aiflib_arc_dec(&dest->more_0->rc_0)) aiflib_dealloc(dest->more_0);
  if (ss == AIFLIB_HEAP_SLEN && src.more_0) aiflib_arc_inc(&src.more_0->rc_0);
  *dest = src;   /* short/medium: bitcopy; long/static: COW share */
}

Aiflib_string aiflib_str_dup(Aiflib_string s) {
  if (aiflib_slen(&s) == AIFLIB_HEAP_SLEN && s.more_0) aiflib_arc_inc(&s.more_0->rc_0);
  return s;
}

void aiflib_str_was_moved(Aiflib_string* s) { s->bytes_0 = 0; s->more_0 = NULL; }

/* ---- integer/bool formatting ---- */
static NI aiflib_fmt_uint(NU64 x, char* buf) {   /* writes digits, returns len */
  char tmp[24]; int i = 0;
  if (x == 0) { buf[0] = '0'; return 1; }
  while (x) { tmp[i++] = (char)('0' + (int)(x % 10)); x /= 10; }
  for (int j = 0; j < i; j++) buf[j] = tmp[i - 1 - j];
  return i;
}
static NI aiflib_fmt_int(NI64 x, char* buf) {
  if (x < 0) { buf[0] = '-'; return 1 + aiflib_fmt_uint((NU64)(-(x + 1)) + 1u, buf + 1); }
  return aiflib_fmt_uint((NU64)x, buf);
}

Aiflib_string aiflib_dollar_int(NI64 x)  { char b[24]; NI n = aiflib_fmt_int(x, b);  return aiflib_str_from_bytes((const NC8*)b, n); }
Aiflib_string aiflib_dollar_uint(NU64 x) { char b[24]; NI n = aiflib_fmt_uint(x, b); return aiflib_str_from_bytes((const NC8*)b, n); }
Aiflib_string aiflib_dollar_bool(NB8 b)  { return b ? aiflib_str_from_bytes((const NC8*)"true", 4) : aiflib_str_from_bytes((const NC8*)"false", 5); }

/* ======================================================================== */
/* IO                                                                       */
/* ======================================================================== */

static void aiflib_raw_write(NI fd, const void* p, NI n) {
  const char* c = (const char*)p;
  NI off = 0;
  while (off < n) {
    ssize_t k = write((int)fd, c + off, (size_t)(n - off));
    if (k <= 0) return;             /* short-write/error: give up (matches false path) */
    off += (NI)k;
  }
}

void aiflib_write_string(Aiflib_File f, Aiflib_string s) {
  NI n = aiflib_str_len(s);
  if (n > 0) aiflib_raw_write(f.fd, aiflib_str_data(&s), n);
}
void aiflib_write_char(Aiflib_File f, NC8 c) { aiflib_raw_write(f.fd, &c, 1); }
void aiflib_write_int(Aiflib_File f, NI64 x)  { char b[24]; NI n = aiflib_fmt_int(x, b);  aiflib_raw_write(f.fd, b, n); }
void aiflib_write_uint(Aiflib_File f, NU64 x) { char b[24]; NI n = aiflib_fmt_uint(x, b); aiflib_raw_write(f.fd, b, n); }
void aiflib_write_bool(Aiflib_File f, NB8 b)  { if (b) aiflib_raw_write(f.fd, "true", 4); else aiflib_raw_write(f.fd, "false", 5); }
void aiflib_write_float(Aiflib_File f, NF64 x) {
  char b[32]; int n = snprintf(b, sizeof b, "%g", (double)x);
  if (n > 0) aiflib_raw_write(f.fd, b, n);
}

void aiflib_flush_std_streams(void) { /* unbuffered raw-fd writes: nothing to flush */ }

/* ======================================================================== */
/* panics / checks / OOM                                                    */
/* ======================================================================== */

void aiflib_panic(Aiflib_string s) {
  NI n = aiflib_str_len(s);
  if (n > 0) aiflib_raw_write(2, aiflib_str_data(&s), n);
  aiflib_raw_write(2, "\n", 1);
  _exit(1);
}

/* Faithful to system/panics.nim raiseIndexError3: "index out of bounds: i notin
 * a..b\n" on stderr, then exit 1.  Shared by every bounds-check variant. */
static void aiflib_raise_index_error(NI64 i, NI64 a, NI64 b) {
  char msg[96];
  int m = snprintf(msg, sizeof msg, "index out of bounds: %lld notin %lld..%lld\n",
                   (long long)i, (long long)a, (long long)b);
  if (m > 0) aiflib_raw_write(2, msg, m);
  _exit(1);
}

/* nimIcheckB(i, b): 0 <= i <= b ? i : panic(i,0,b). */
NI aiflib_icheck_b(NI i, NI b) {
  if (i >= 0 && i <= b) return i;
  aiflib_raise_index_error(i, 0, b);
  return 0;
}

/* nimIcheckAB(i, a, b): a <= i <= b ? i-a : panic(i,a,b).  Returns the OFFSET. */
NI aiflib_icheck_ab(NI i, NI a, NI b) {
  if (i >= a && i <= b) return i - a;
  aiflib_raise_index_error(i, a, b);
  return 0;
}

/* nimUcheckB(i, b): unsigned; i <= b ? i : panic. */
NU aiflib_ucheck_b(NU i, NU b) {
  if (i <= b) return i;
  aiflib_raise_index_error((NI64)i, 0, (NI64)b);
  return 0;
}

/* nimUcheckAB(i, a, b): unsigned; r=i-a (wraps); r <= b ? r : panic.  A wrapped
 * (i<a) result exceeds b and panics, matching the Nim unsigned-subtraction path. */
NU aiflib_ucheck_ab(NU i, NU a, NU b) {
  NU r = i - a;
  if (r <= b) return r;
  aiflib_raise_index_error((NI64)i, (NI64)a, (NI64)b);
  return 0;
}

void aiflib_oom_handler(NI size) { (void)size; /* continue-after-OOM: no-op */ }

/* ======================================================================== */
/* seq growth (system/seqimpl.nim recalcCap)                                */
/* ======================================================================== */

/* recalcCap(oldCap, addedElements): new capacity for a growing seq.  Faithful
 * to nimony's overflow-flag logic: required = old+added (saturate to high(int)
 * on overflow); otherwise 1.5x growth, clamped up to `required`, and if the
 * 1.5x step itself overflows, fall back to `required`. */
NI aiflib_recalc_cap(NI oldCap, NI added) {
  NI required;
  if (__builtin_add_overflow(oldCap, added, &required))
    return (NI)0x7fffffffffffffffLL;              /* high(int) */
  NI grow;
  if (__builtin_add_overflow(oldCap, oldCap >> 1, &grow))
    return required;
  return grow > required ? grow : required;
}

void aiflib_noop(void) { }
