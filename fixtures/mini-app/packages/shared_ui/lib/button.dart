import 'package:flutter/material.dart';

/// A shared primary button.
class PrimaryButton extends StatelessWidget {
  const PrimaryButton({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) => Text(label);
}
