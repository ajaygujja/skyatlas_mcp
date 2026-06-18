/// BlocProvider<T> in a list mis-parses at collection position as
/// relational_expression. Both arrow and block-body create must emit createsBloc.
import 'package:flutter/material.dart';

class MultiTypedScreen extends StatelessWidget {
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
