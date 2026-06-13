// `@riverpod` code-generated providers — the companion `*.g.dart` declares the
// real provider; we record the annotated source declaration.
import 'package:riverpod_annotation/riverpod_annotation.dart';

import 'models.dart';

part 'generated_providers.g.dart';

// Function form: `@riverpod` on a top-level function.
@riverpod
int count(CountRef ref) => 0;

// Class form: `@riverpod` on a Notifier subclass.
@riverpod
class UserController extends _$UserController {
  @override
  User build() => User();

  void refresh() {}
}

// `@Riverpod(keepAlive: true)` — capitalized annotation with args, still ours.
@Riverpod(keepAlive: true)
String appTitle(AppTitleRef ref) => 'demo';
