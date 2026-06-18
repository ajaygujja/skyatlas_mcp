// Repro fixtures for get_widget_tree shallow-AST bugs (RC1).
// Each class mirrors a real arena_360 widget pattern that the extractor drops.
// See scripts/repro-widget-tree.ts for the dumped (buggy) output.

import 'package:flutter/material.dart';

// ── CONTROL: bare `return Widget(...)` — extractor handles this correctly. ──
class ControlCard extends StatelessWidget {
  const ControlCard({super.key});

  @override
  Widget build(BuildContext context) {
    return Material(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Column(
          children: [
            const Text('header'),
            const Text('body'),
          ],
        ),
      ),
    );
  }
}

// ── BUG B3: leading `X.of(context)` local + conditional returns. ──
// Mirrors FormSelectField. Expect: _DropdownField / _RadioField branches.
// Actual: root becomes `ReadOnlyScope.of` (a bool!), real returns dropped.
class ConditionalReturnField extends StatelessWidget {
  const ConditionalReturnField({required this.dropdown, super.key});

  final bool dropdown;

  @override
  Widget build(BuildContext context) {
    final enabled = !ReadOnlyScope.of(context);
    if (dropdown) {
      return _DropdownField(enabled: enabled);
    }
    return _RadioField(enabled: enabled);
  }
}

// ── BUG B1+B2: builder callback returns a private helper method. ──
// Mirrors FormTableField. Expect: full Table/Column tree.
// Actual: dead-ends at `Builder` — `_buildBody` is lowercase, not a constructor.
class BuilderHelperField extends StatelessWidget {
  const BuilderHelperField({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<SomeCubit>(
      create: (_) => SomeCubit(),
      child: Builder(
        builder: (ctx) => _buildBody(ctx),
      ),
    );
  }

  Widget _buildBody(BuildContext context) {
    return Column(
      children: [
        const Text('row 1'),
        const Text('row 2'),
      ],
    );
  }
}

// ── BUG B1: builder closure with a body block returning a real widget tree. ──
// Mirrors _DropdownSelectField. Expect: ListenableBuilder → Column → children.
// Actual: root becomes `Scope.of`; ListenableBuilder subtree dropped.
class ListenableField extends StatelessWidget {
  const ListenableField({super.key});

  @override
  Widget build(BuildContext context) {
    final controller = Scope.of(context);
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        return Column(
          children: [
            const Text('label'),
            const Text('value'),
          ],
        );
      },
    );
  }
}

// ── BUG N2: `.map((x) => Widget())` unrolled once + mis-tagged [builder]. ──
// Mirrors QuickActionsSection. Expect: dynamic collection NOT shown as a single
// static child (honesty: "loops/conditionals not unrolled"). Actual: one
// `Expanded` emitted as a static child of `children:`, tagged [builder].
class MappedChildrenField extends StatelessWidget {
  const MappedChildrenField({required this.items, super.key});

  final List<String> items;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: items
          .map((item) => Expanded(child: Text(item)))
          .toList(),
    );
  }
}

// ── BUG N2 (spread variant): `...items.map((x) => Widget())` dropped. ──
// Mirrors a section that splices a mapped list into a children array. Expect:
// the `.map` closure surfaces one representative child marked dynamic (mapped),
// the plain spread stays a dynamic marker. Actual: only `...items` emitted, the
// mapped widget vanishes.
class SpreadMappedChildrenField extends StatelessWidget {
  const SpreadMappedChildrenField({required this.items, super.key});

  final List<String> items;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const Header(),
        ...items.map((item) => Expanded(child: Text(item))),
        ...footerWidgets,
      ],
    );
  }
}

// ── BUG B3 (early-return variant): loading guard return hides the main tree. ──
// Mirrors _IssueHistoryViewState. Expect: the ListView branch.
// Actual: only the first `return` (loading SizedBox) is shown.
class EarlyReturnField extends StatelessWidget {
  const EarlyReturnField({required this.loading, super.key});

  final bool loading;

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return const SizedBox(child: Center(child: Text('loading')));
    }
    return ListView(
      children: const [Text('a'), Text('b')],
    );
  }
}

// ── BUG B4: BlocProvider inside MultiBlocProvider(providers:[...]) ──
// with a block-body create dispatching events.
// Mirrors FormScreen. Expect: providers recognised, child Body.
// Actual: generic mis-parse + `..add(Event())` listed as phantom providers.
class MultiProviderScreen extends StatelessWidget {
  const MultiProviderScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiBlocProvider(
      providers: [
        BlocProvider<SomeBloc>(
          create: (context) {
            final bloc = SomeBloc();
            bloc.add(const LoadEvent());
            return bloc;
          },
        ),
      ],
      child: const Body(),
    );
  }
}
