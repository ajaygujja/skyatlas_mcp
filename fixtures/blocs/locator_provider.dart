/// BlocProvider(create:) handing off to a service locator — the cubit lives in
/// `sl<X>()` type arguments, not as a plain identifier. Also exercises a typed
/// closure parameter (`BuildContext context`) whose PascalCase type must NOT be
/// mistaken for the created bloc.
import 'package:flutter/material.dart';

class WorkLogListScreen extends StatelessWidget {
  const WorkLogListScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider(
      create: (_) => sl<WorkLogListCubit>()..loadWorkLogs(),
      child: const _WorkLogListView(),
    );
  }
}

class SearchScreen extends StatelessWidget {
  const SearchScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider(
      create: (BuildContext context) => getIt<SearchCubit>(),
      child: const _SearchView(),
    );
  }
}
