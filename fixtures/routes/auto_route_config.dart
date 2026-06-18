import 'package:auto_route/auto_route.dart';

import 'auto_route_app.gr.dart';

/// auto_route: @RoutePage marks the screens (hand-written), and the
/// RootStackRouter holds the AutoRoute table referencing the generated
/// `*.page` entries — paths, guards, and `children:` nesting all live here.
@RoutePage()
class HomeScreen extends StatelessWidget {}

@RoutePage(name: 'ProfileRoute')
class ProfileScreen extends StatelessWidget {}

@RoutePage()
class DashboardScreen extends StatelessWidget {}

@RoutePage()
class StatsScreen extends StatelessWidget {}

@AutoRouterConfig()
class AppRouter extends RootStackRouter {
  @override
  List<AutoRoute> get routes => [
        AutoRoute(page: HomeRoute.page, initial: true),
        AutoRoute(
          page: ProfileRoute.page,
          path: '/profile',
          guards: [AuthGuard],
        ),
        AutoRoute(
          page: DashboardRoute.page,
          path: '/dashboard',
          children: [
            AutoRoute(page: StatsRoute.page, path: 'stats'),
          ],
        ),
        RedirectRoute(path: '*', redirectTo: '/login'),
      ];
}
