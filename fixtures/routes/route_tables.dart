import 'package:go_router/go_router.dart';

/// Static route tables mounted into the app router by `...Owner.routes()`
/// spreads. Because the tables are fully static, get_route_graph splices their
/// routes into the graph instead of reporting the spread as unknown. A spread
/// whose owner has no indexed table, and a self-referential table, stay honest.

class ModuleNavigation {
  static List<RouteBase> routes() => [
        GoRoute(path: '/module', builder: (c, s) => const ModuleScreen()),
        GoRoute(path: '/module/detail', builder: (c, s) => const ModuleDetailScreen()),
      ];
}

class ExtraNavigation {
  // Block body exercises the `{ return [...]; }` shape alongside the arrow form.
  static List<GoRoute> routes() {
    return [
      GoRoute(path: '/extra', builder: (c, s) => const ExtraScreen()),
    ];
  }
}

class CyclicNavigation {
  static List<RouteBase> routes() => [
        GoRoute(path: '/cyclic', builder: (c, s) => const CyclicScreen()),
        ...CyclicNavigation.routes(),
      ];
}

final GoRouter tableRouter = GoRouter(
  routes: [
    GoRoute(path: '/host', builder: (c, s) => const HostScreen()),
    ...ModuleNavigation.routes(),
    ...ExtraNavigation.routes(),
    ...CyclicNavigation.routes(),
    ...MissingNavigation.routes(),
  ],
);
