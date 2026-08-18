import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import 'counter_cubit.dart';

/// Reads one Cubit from several places in a single file — the shape that makes a
/// response repeat one fact per call site instead of once per file.
class RepeatReadScreen extends StatelessWidget {
  const RepeatReadScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final first = context.read<CounterCubit>();
    final second = context.read<CounterCubit>();
    final third = context.read<CounterCubit>();
    return Text('${first.state}${second.state}${third.state}');
  }
}
