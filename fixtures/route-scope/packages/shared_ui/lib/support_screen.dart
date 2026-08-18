import 'package:flutter/material.dart';

/// Screen declared in a sibling package and outside any feature folder.
class SupportScreen extends StatelessWidget {
  const SupportScreen({super.key});

  @override
  Widget build(BuildContext context) => const Placeholder();
}

/// Shell wrapper for the routes nested under it.
class AppShell extends StatelessWidget {
  const AppShell({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context) => child;
}
