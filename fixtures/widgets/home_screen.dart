import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

/// Top-level screen wiring a Bloc into its subtree.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: BlocBuilder<HomeBloc, HomeState>(
        builder: (context, state) {
          return ListView.builder(
            itemCount: state.items.length,
            itemBuilder: (context, index) {
              return ListTile(title: Text(state.items[index]));
            },
          );
        },
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => context.read<HomeBloc>().add(const HomeRefreshed()),
        child: const Icon(Icons.refresh),
      ),
    );
  }
}
