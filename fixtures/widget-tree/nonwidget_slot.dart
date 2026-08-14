import 'package:flutter/material.dart';

/// ISSUE-1 Layer B fixture: a non-widget constructor sitting in an ordinary
/// layout slot (`children:`), not a denylisted one — the case Layer A's slot
/// filter cannot catch. Only the index-backed filter in get-widget-tree.ts
/// can positively identify this as non-layout.
class BaseEvent {
  const BaseEvent();
}

class LoadDataEvent extends BaseEvent {
  const LoadDataEvent();
}

/// Same name declared in two files (see nonwidget_slot_dup.dart) — ambiguous,
/// so the filter must keep it rather than guess which declaration applies.
class DuplicateNode extends BaseEvent {
  const DuplicateNode();
}

class NonWidgetHostScreen extends StatelessWidget {
  const NonWidgetHostScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          const HeaderCard(),
          const LoadDataEvent(),
          const Placeholder(),
          const DuplicateNode(),
        ],
      ),
    );
  }
}
