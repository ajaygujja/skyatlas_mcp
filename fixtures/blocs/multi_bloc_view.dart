import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import 'user_bloc.dart';

/// Pins the §2 mis-parse: a `BlocBuilder<A, B>(…)` sitting in a named-arg value
/// that follows a sibling named arg (`create:` then `child:`) parses as a
/// `relational_expression`, not a clean invocation. The readsBloc edge must
/// still resolve the bloc (first type arg) via recovery.
class MultiBlocView extends StatelessWidget {
  const MultiBlocView({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider(
      create: (_) => UserBloc(context.read<UserRepository>()),
      child: BlocBuilder<UserBloc, UserState>(
        builder: (context, state) => const SizedBox(),
      ),
    );
  }
}
