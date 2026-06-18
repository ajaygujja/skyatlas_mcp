// Stress fixture: tricky declarations for the symbol extractor.
// Run: pnpm tsx scripts/repro-extract.ts fixtures/stress/symbols_hard.dart widgets  (use a symbols dump if available)
library;

// Generic class with bound + operator overloads.
class Box<T extends Comparable<T>> {
  Box(this.value);
  final T value;
  bool operator <(Box<T> other) => value.compareTo(other.value) < 0;
  T operator [](int i) => value;
  Box<T> copy() => Box(value);
}

// Sealed class hierarchy (Dart 3).
sealed class Shape {}
final class Circle extends Shape {
  Circle(this.r);
  final double r;
}
final class Square extends Shape {
  Square(this.side);
  final double side;
}

// Extension type (Dart 3.3).
extension type UserId(String value) {
  bool get isValid => value.isNotEmpty;
}

// Mixin class (Dart 3).
mixin class Loggable {
  void log(String m) {}
}

// Typedef: function type + record type.
typedef Callback = void Function(int code, {String? reason});
typedef Pair = (int, String);

// Top-level function with named + optional positional params and a record return.
(int, {String label}) describe(int n, [bool verbose = false]) => (n, label: '');

// Enum with members and methods.
enum Priority {
  low(0),
  high(10);

  const Priority(this.weight);
  final int weight;
  bool get urgent => weight > 5;
}
