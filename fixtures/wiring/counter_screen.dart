import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import 'counter_cubit.dart';
import 'repositories.dart';

/// Stateless screen: creates a Cubit and reads it back in a BlocBuilder.
class CounterScreen extends StatelessWidget {
  const CounterScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider(
      create: (_) => CounterCubit(CounterRepository()),
      child: BlocBuilder<CounterCubit, int>(
        builder: (context, count) => Text('$count'),
      ),
    );
  }
}
