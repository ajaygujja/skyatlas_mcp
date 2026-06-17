// Stress fixture: widget build() patterns beyond a single real repo.
// Run: pnpm tsx scripts/repro-extract.ts fixtures/stress/widgets_hard.dart widgets
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

// Ternary return at root: expect BOTH branches (or honest "conditional").
class TernaryRoot extends StatelessWidget {
  const TernaryRoot({required this.dark, super.key});
  final bool dark;
  @override
  Widget build(BuildContext context) {
    return dark ? const DarkScreen() : const LightScreen();
  }
}

// Dart 3 switch-expression return: expect the case widgets.
class SwitchReturn extends StatelessWidget {
  const SwitchReturn({required this.status, super.key});
  final Status status;
  @override
  Widget build(BuildContext context) {
    return switch (status) {
      Status.loading => const LoadingView(),
      Status.error => const ErrorView(),
      Status.ok => const OkView(),
    };
  }
}

// Standalone 2-type-arg generic at root (the documented mis-parse case).
class BlocBuilderRoot extends StatelessWidget {
  const BlocBuilderRoot({super.key});
  @override
  Widget build(BuildContext context) {
    return BlocBuilder<CounterBloc, CounterState>(
      builder: (context, state) => Text('${state.count}'),
    );
  }
}

// Nested generics in a builder type arg: ValueListenableBuilder<List<int>>.
class NestedGeneric extends StatelessWidget {
  const NestedGeneric({required this.listenable, super.key});
  final ValueListenable<List<int>> listenable;
  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<List<int>>(
      valueListenable: listenable,
      builder: (context, value, _) => Text('${value.length}'),
    );
  }
}

// Collection-if and spread in children: dynamic, expect honest handling.
class CollectionIfChildren extends StatelessWidget {
  const CollectionIfChildren({required this.showBanner, super.key});
  final bool showBanner;
  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const Header(),
        if (showBanner) const Banner(),
        ...footerWidgets,
        const Footer(),
      ],
    );
  }
}

// Cascade on the returned widget.
class CascadeReturn extends StatelessWidget {
  const CascadeReturn({super.key});
  @override
  Widget build(BuildContext context) {
    return Container()..color;
  }
}
