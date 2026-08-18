import 'package:go_router/go_router.dart';

import 'counter_screen.dart';
import 'orphan_screen.dart';
import 'profile_screen.dart';
import 'settings_screen.dart';

/// Paths held as class consts. This is the shape that leaves `RouteInfo.pathExpr`
/// set and both `path` and `fullPath` empty, so the path exists only once the
/// index resolves the const.
class RoutePaths {
  static const String settings = '/settings';
  static const String profile = '/profile';
  static const String edit = 'edit';
}

/// A static route table mounted by a `...Owner.routes()` spread. Its routes are
/// reachable only after the table is spliced into the forest — they are not in
/// `index.routes` themselves.
class ModuleNavigation {
  static List<RouteBase> routes() => [
        GoRoute(path: '/module', builder: (c, s) => const OrphanScreen()),
      ];
}

final router = GoRouter(
  routes: [
    /// Literal path: reachable without any resolution.
    GoRoute(
      path: '/counter',
      name: 'counter',
      builder: (context, state) => const CounterScreen(),
    ),

    /// Const path on the route itself.
    GoRoute(
      path: RoutePaths.settings,
      name: 'settings',
      builder: (context, state) => const SettingsScreen(),
    ),

    /// Relative const child under a const parent: the full path exists only
    /// after both consts resolve and the segments join.
    GoRoute(
      path: RoutePaths.profile,
      routes: [
        GoRoute(
          path: RoutePaths.edit,
          name: 'profileEdit',
          builder: (context, state) => const ProfileScreen(),
        ),
      ],
    ),

    ...ModuleNavigation.routes(),
  ],
);
