import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

/// Riverpod ConsumerWidget — flavor 'consumer'.
class ProfileView extends ConsumerWidget {
  const ProfileView({super.key, required this.userId});

  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(userProvider(userId));
    return Column(
      children: [
        Text(user.name),
        const Divider(),
        ElevatedButton(
          onPressed: () => ref.read(userProvider(userId).notifier).refresh(),
          child: const Text('Refresh'),
        ),
      ],
    );
  }
}

/// flutter_hooks HookWidget — flavor 'hook'.
class CounterBadge extends HookWidget {
  const CounterBadge({super.key});

  @override
  Widget build(BuildContext context) {
    final count = useState(0);
    return GestureDetector(
      onTap: () => count.value++,
      child: Badge(label: Text('${count.value}')),
    );
  }
}

/// Plain non-widget class — must NOT be picked up as a widget.
class ProfileRepository {
  Future<String> fetchName() async => 'Ada';
}
