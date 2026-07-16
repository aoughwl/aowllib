import std/syncio
var a = "this is a fairly long heap string"
var b = a
b[0] = 'X'
echo a
echo b
var lit = "another long literal over fourteen chars"
lit[0] = 'Z'
echo lit
var short = "hello"
short[0] = 'H'
echo short
