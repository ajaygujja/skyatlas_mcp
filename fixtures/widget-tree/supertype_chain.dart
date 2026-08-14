import 'package:flutter/material.dart';

/// A 3-level widget subclass chain: `BaseCard` extends `StatelessWidget`
/// directly and is registered in `index.widgets`, but `FancyCard` and
/// `SpecialCard` each extend an already-indexed widget rather than a Flutter
/// base class directly, so neither is itself an `index.widgets` entry even
/// though both are real widgets. `get_widget_tree`'s non-widget filter must
/// resolve `SpecialCard`'s declared supertype chain up through `FancyCard` to
/// `BaseCard` and recognize it as a known widget, rather than concluding
/// non-widget from `FancyCard` alone.
class BaseCard extends StatelessWidget {
  const BaseCard({super.key});

  @override
  Widget build(BuildContext context) => const Placeholder();
}

class FancyCard extends BaseCard {
  const FancyCard({super.key});
}

class SpecialCard extends FancyCard {
  const SpecialCard({super.key});
}

class ChainHostScreen extends StatelessWidget {
  const ChainHostScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: const SpecialCard(),
    );
  }
}
