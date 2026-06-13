// A ConsumerWidget reading providers — exercises the watchesProvider edges.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'providers.dart';

class HomeView extends ConsumerWidget {
  const HomeView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(counterProvider);
    ref.read(userProvider);
    ref.listen(asyncUserProvider, (prev, next) {});
    // `.notifier` suffix — base provider must still resolve.
    final notifier = ref.watch(userNotifierProvider.notifier);
    return Text('$count');
  }
}
