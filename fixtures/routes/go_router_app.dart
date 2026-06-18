import 'package:go_router/go_router.dart';

import 'screens.dart';

/// A representative go_router table: a router-level `redirect:` guard, nested
/// GoRoute, a ShellRoute wrapper (no own path), a tear-off redirect guard, a
/// pageBuilder that wraps the real screen in a MaterialPage, and a builder that
/// wraps the real screen in a BlocProvider.
final GoRouter appRouter = GoRouter(
  initialLocation: '/',
  redirect: rootRedirect,
  routes: [
    GoRoute(
      path: '/',
      name: 'home',
      builder: (context, state) => const HomeScreen(),
      routes: [
        GoRoute(
          path: 'settings',
          name: 'settings',
          builder: (context, state) => const SettingsScreen(),
          routes: [
            GoRoute(
              path: 'about',
              builder: (context, state) => AboutScreen(),
            ),
          ],
        ),
      ],
    ),
    ShellRoute(
      builder: (context, state, child) => ScaffoldShell(child: child),
      routes: [
        GoRoute(
          path: '/profile',
          redirect: authGuard,
          pageBuilder: (context, state) =>
              MaterialPage(child: const ProfilePage()),
        ),
        GoRoute(
          path: '/profile/edit',
          builder: (context, state) => EditProfileScreen(),
        ),
      ],
    ),
    GoRoute(
      path: '/feed',
      name: 'feed',
      builder: (context, state) => BlocProvider(
        create: (context) => FeedBloc(),
        child: const FeedScreen(),
      ),
    ),
  ],
);
