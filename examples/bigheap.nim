import std/syncio
var s = ""
var i = 0
while i < 500:
  s = s & "x"
  i = i + 1
echo s.len
echo s[0]
echo s[499]
