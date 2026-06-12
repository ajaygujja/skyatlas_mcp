class Working {
  void fine() {}
}

class Broken {
  // missing initializer expression below — a localized syntax error
  int bad = ;
}

class AfterError {
  int alive = 1;
}
