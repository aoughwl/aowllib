import std/syncio
var parts = @["foo", "bar", "baz"]
var acc = ""
for p in parts:
  acc = acc & p
  acc = acc & "-"
echo acc
