import std/syncio
type
  Kind = enum kInt, kStr
  Val = object
    tag: int
    case kind: Kind
    of kInt: i: int
    of kStr: s: string
proc show(v: Val) =
  case v.kind
  of kInt: echo v.i
  of kStr: echo v.s
var a = Val(tag: 1, kind: kInt, i: 42)
var b = Val(tag: 2, kind: kStr, s: "hello")
show(a)
show(b)
echo a.tag
