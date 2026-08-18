/// Second declaration of `DuplicateNode` (see nonwidget_slot.dart) — makes the
/// name ambiguous in the index so ISSUE-1 Layer B must keep it rather than
/// resolve to either one.
class SomeOtherBase {
  const SomeOtherBase();
}

class DuplicateNode extends SomeOtherBase {
  const DuplicateNode();
}
