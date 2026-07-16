import std/syncio
type
  Animal = ref object of RootObj
  Dog = ref object of Animal
  Cat = ref object of Animal
method speak(a: Animal): int {.base.} = 0
method speak(d: Dog): int = 1
method speak(c: Cat): int = 2
proc test(a: Animal): int = speak(a)
var d: Animal = Dog()
var c: Animal = Cat()
echo test(d)
echo test(c)
