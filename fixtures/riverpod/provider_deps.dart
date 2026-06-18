// A provider whose create closure reads another provider — the watchesProvider
// edge's `from` should be the enclosing provider, not the file (#3).
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'models.dart';

final baseProvider = Provider<int>((ref) => 0);

// `ref.watch` inside this provider's body depends on baseProvider.
final derivedProvider = Provider<int>((ref) {
  final base = ref.watch(baseProvider);
  return base + 1;
});
