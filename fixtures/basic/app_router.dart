import 'package:go_router/go_router.dart';

import 'settings_screen.dart';

const String kHomePath = '/';
int navigationCount = 0;

final GoRouter appRouter = GoRouter(
  routes: [
    GoRoute(
      path: '/',
      builder: (context, state) => const HomeScreen(),
      routes: [
        GoRoute(
          path: 'settings',
          builder: (context, state) => const SettingsScreen(title: 'Settings'),
        ),
      ],
    ),
  ],
);

String describeLocation(String location) {
  navigationCount += 1;
  return 'at $location';
}
