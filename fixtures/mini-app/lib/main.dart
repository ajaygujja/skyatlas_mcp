import 'package:flutter/material.dart';
import 'package:mini_app/blocs/user_bloc.dart';
import 'package:shared_ui/button.dart' as ui;

void main() => runApp(const MiniApp());

class MiniApp extends StatelessWidget {
  const MiniApp({super.key});

  @override
  Widget build(BuildContext context) => const MaterialApp(home: HomeScreen());
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) => const Scaffold();
}
