// Stress fixture: auto_route hand-written table (arena-360 uses go_router).
// Run: pnpm tsx scripts/repro-extract.ts fixtures/stress/auto_route_app.dart routes
import 'package:auto_route/auto_route.dart';

@AutoRouterConfig()
class AppRouter extends RootStackRouter {
  @override
  List<AutoRoute> get routes => [
        AutoRoute(page: LoginRoute.page, path: '/login', initial: true),
        AutoRoute(
          page: DashboardRoute.page,
          path: '/dashboard',
          guards: [AuthGuard],
          children: [
            AutoRoute(page: SettingsRoute.page, path: 'settings'),
            AutoRoute(page: ProfileRoute.page, path: 'profile/:id'),
          ],
        ),
        RedirectRoute(path: '*', redirectTo: '/login'),
      ];
}
