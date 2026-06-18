import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import 'typed_blocs.dart';

/// Covers B5: BlocProvider<T> in a providers list. The typed generic at
/// collection position mis-parses as relational_expression — both arrow and
/// block-body create forms must still emit a createsBloc edge.
class TypedBlocScreen extends StatelessWidget {
  const TypedBlocScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiBlocProvider(
      providers: [
        BlocProvider<ArrowBloc>(
          create: (_) => sl<ArrowBloc>(),
        ),
        BlocProvider<BlockBodyBloc>(
          create: (context) {
            final bloc = sl<BlockBodyBloc>();
            return bloc;
          },
        ),
      ],
      child: const SizedBox(),
    );
  }
}
