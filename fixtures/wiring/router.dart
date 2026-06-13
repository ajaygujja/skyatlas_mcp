import 'package:go_router/go_router.dart';

import 'counter_screen.dart';

/// One route so screen wiring is reachable by route too (RouteInfo.screenWidget).
final router = GoRouter(
  routes: [
    GoRoute(
      path: '/counter',
      name: 'counter',
      builder: (context, state) => const CounterScreen(),
    ),
  ],
);
