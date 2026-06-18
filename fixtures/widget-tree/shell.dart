import 'package:flutter/material.dart';

// A thin shell: the StatelessWidget wraps a single body widget whose real tree
// lives elsewhere (StatefulWidget → State). Exercises follow across both hops.
class ShellScreen extends StatelessWidget {
  const ShellScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: const BodyView(),
    );
  }
}

class BodyView extends StatefulWidget {
  const BodyView({super.key});

  @override
  State<BodyView> createState() => _BodyViewState();
}

class _BodyViewState extends State<BodyView> {
  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const HeaderCard(),
        const Text('inline'),
      ],
    );
  }
}

// A leaf widget with its own static tree — follow keeps expanding past the shell.
class HeaderCard extends StatelessWidget {
  const HeaderCard({super.key});

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.zero,
      child: Text('header'),
    );
  }
}
