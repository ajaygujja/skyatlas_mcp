import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

/// Reads a bloc that is NOT declared anywhere in the index — the `to` stays a
/// bare name and is reported as unresolved (never invented).
class ExternalScreen extends StatelessWidget {
  const ExternalScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final bloc = context.read<ExternalBloc>();
    return Text(bloc.toString());
  }
}
