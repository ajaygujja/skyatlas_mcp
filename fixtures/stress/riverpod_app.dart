// Stress fixture: Riverpod (arena-360 is Bloc-only, so this is untested surface).
// Run: pnpm tsx scripts/repro-extract.ts fixtures/stress/riverpod_app.dart providers
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/material.dart';

// Global providers, various constructors.
final counterProvider = StateProvider<int>((ref) => 0);
final repoProvider = Provider<Repo>((ref) => Repo());
final userProvider = FutureProvider<User>((ref) async => ref.read(repoProvider).fetch());
final settingsProvider =
    StateNotifierProvider<SettingsNotifier, Settings>((ref) => SettingsNotifier());
// Nested generic in the provider type arg.
final listProvider = StateProvider<List<int>>((ref) => []);
// .family and .autoDispose modifiers.
final itemProvider = FutureProvider.family<Item, String>((ref, id) async => fetchItem(id));
final tmpProvider = Provider.autoDispose<int>((ref) => 1);

// Generated provider.
@riverpod
int doubled(DoubledRef ref) => ref.watch(counterProvider) * 2;

@riverpod
class AsyncTodos extends _$AsyncTodos {
  @override
  Future<List<Todo>> build() async => [];
}

// ConsumerWidget that reads/watches providers — wiring surface.
class HomeView extends ConsumerWidget {
  const HomeView({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(counterProvider);
    final settings = ref.watch(settingsProvider);
    ref.listen(userProvider, (prev, next) {});
    return Text('$count $settings');
  }
}
