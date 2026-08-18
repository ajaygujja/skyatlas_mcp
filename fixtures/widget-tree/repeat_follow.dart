import 'package:flutter/material.dart';

// The same child widget in two slots. Both are real call sites, but the class
// has one static tree, so a follow walk that expands it twice pays for the same
// subtree twice.
class RepeatFollowScreen extends StatelessWidget {
  const RepeatFollowScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const RepeatedCard(),
        const RepeatedCard(),
      ],
    );
  }
}

class RepeatedCard extends StatelessWidget {
  const RepeatedCard({super.key});

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.zero,
      child: Text('repeated'),
    );
  }
}
