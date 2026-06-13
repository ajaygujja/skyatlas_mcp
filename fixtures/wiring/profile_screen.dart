import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import 'profile_bloc.dart';

/// Stateful screen: the bloc read happens inside the companion State class, so
/// the edge's `from` is `_ProfileScreenState`, not `ProfileScreen`. Wiring must
/// reach it via the State<ProfileScreen> companion link.
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  @override
  Widget build(BuildContext context) {
    final bloc = context.read<ProfileBloc>();
    return Text(bloc.toString());
  }
}
