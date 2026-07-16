import std/syncio
type
  A = object of RootObj
    a: int
  B = object of A
    b: int
  C = object of B
    c: int
var x = C(a: 1, b: 2, c: 3)
echo x.a
echo x.b
echo x.c
