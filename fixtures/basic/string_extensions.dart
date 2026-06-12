mixin Validatable {
  List<String> validate();

  bool get isValid => validate().isEmpty;
}

extension StringX on String {
  bool get isBlank => trim().isEmpty;

  String truncate(int max) {
    if (length <= max) return this;
    return '${substring(0, max)}…';
  }
}

abstract class Formatter {
  String format(String input);
}
