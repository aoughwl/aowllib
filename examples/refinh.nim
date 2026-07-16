import std/syncio
type
  Shape = ref object of RootObj
    sides: int
  Square = ref object of Shape
    size: int
var sq = Square(sides: 4, size: 10)
echo sq.sides
echo sq.size
