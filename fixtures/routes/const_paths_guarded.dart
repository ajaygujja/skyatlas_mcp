/// go_router table whose paths are class consts (`RoutePaths.home`) and whose
/// pageBuilders open with a null-guard early return before the real screen.
/// Exercises: const-path capture (pathExpr) and last-return screen resolution
/// (the guard's ErrorPage must NOT win over the real screen).
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class RoutePaths {
  static const String home = '/home';
  static const detail = '/detail';
  static const edit = 'edit';
}

/// B6/N1: enum-backed route paths — `AppRoutes.splash.path` must resolve to
/// `/splash`, and `AppRoutes.splash.name` to `splash`.
enum AppRoutes {
  splash('/splash'),
  profile('/profile');

  const AppRoutes(this.path);
  final String path;
}

final router = GoRouter(
  routes: [
    GoRoute(
      path: RoutePaths.home,
      builder: (context, state) => const HomeScreen(),
    ),
    GoRoute(
      path: RoutePaths.detail,
      pageBuilder: (context, state) {
        final workLog = state.extra as WorkLog?;
        if (workLog == null) {
          return const MaterialPage(child: ErrorPage());
        }
        return MaterialPage(child: WorkLogDetailScreen(id: workLog.id));
      },
      routes: [
        GoRoute(
          path: RoutePaths.edit,
          pageBuilder: (context, state) {
            final workLog = state.extra as WorkLog?;
            if (workLog == null) {
              return const MaterialPage(child: ErrorPage());
            }
            return MaterialPage(child: WorkLogEditScreen());
          },
        ),
      ],
    ),
    GoRoute(
      path: RoutePaths.unmapped,
      builder: (context, state) => const MysteryScreen(),
    ),
    GoRoute(
      path: AppRoutes.splash.path,
      builder: (context, state) => const SplashScreen(),
    ),
  ],
);
