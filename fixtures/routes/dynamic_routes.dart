import 'package:go_router/go_router.dart';

/// Routes the syntax layer cannot see (§12, Working Rule 8). Honest absence:
/// the indirection and the for/spread elements must be reported as unknown,
/// not fabricated. The one static GoRoute in `dynamicRouter` is still extracted.
final GoRouter indirectRouter = GoRouter(routes: sharedRoutes);

final GoRouter dynamicRouter = GoRouter(
  routes: [
    for (final tab in tabs)
      GoRoute(path: tab.path, builder: (c, s) => TabScreen(tab)),
    ...legacyRoutes,
    GoRoute(path: '/static', builder: (c, s) => const StaticScreen()),
  ],
);
