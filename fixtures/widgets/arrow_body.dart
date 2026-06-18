import 'package:flutter/material.dart';

// Expression-bodied build() methods: no return_statement in the CST, the
// returned widget hangs directly off function_body. Regression guard for the
// arrow-body path in collectBuildRoots.

// `=> const Foo(...)` parses as a const_object_expression.
class ConstArrowScreen extends StatelessWidget {
  const ConstArrowScreen({super.key});

  @override
  Widget build(BuildContext context) => const MaterialApp(home: HomeBody());
}

// `=> Foo(...)` (non-const) parses as identifier + selector siblings.
class PlainArrowScreen extends StatelessWidget {
  const PlainArrowScreen({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(body: const HomeBody());
}

class HomeBody extends StatelessWidget {
  const HomeBody({super.key});

  @override
  Widget build(BuildContext context) => const SizedBox();
}
