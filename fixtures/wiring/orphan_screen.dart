import 'package:flutter/material.dart';

/// A screen with no state-management wiring at all — exercises honest absence.
class OrphanScreen extends StatelessWidget {
  const OrphanScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Text('orphan');
  }
}
