import std/syncio
type
  Animal = object of RootObj
    name: int
  Dog = object of Animal
    breed: int
var d = Dog(name: 5, breed: 9)
echo d.name
echo d.breed
