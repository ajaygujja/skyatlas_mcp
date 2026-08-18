import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

/// Regression fixture for ISSUE-1: a `listener:` callback that dispatches a
/// Bloc event constructor with a spread argument must not surface as a
/// static layout node (the event class is not a widget).
class FormRejectedVersionDetailsScreen extends StatelessWidget {
  const FormRejectedVersionDetailsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: BlocListener<FormRejectedVersionCubit, FormRejectedVersionState>(
        listener: (context, state) {
          context.read<FormPlayerBloc>().add(
            FormPlayerLoadConfigForRejectedVersionEvent(
              formId: formId,
              rejectedFields: {
                ...?version?.standardFields,
                ...?version?.customFields,
              },
            ),
          );
        },
        child: const Text('Rejected version'),
      ),
    );
  }
}
