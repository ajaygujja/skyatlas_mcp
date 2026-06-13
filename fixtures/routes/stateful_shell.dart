import 'package:go_router/go_router.dart';

/// StatefulShellRoute.indexedStack: a named-constructor route whose children
/// live inside `branches:` (one StatefulShellBranch per tab), each branch
/// holding its own `routes:` list. The shell itself has no path.
final GoRouter tabbedRouter = GoRouter(
  routes: [
    StatefulShellRoute.indexedStack(
      builder: (context, state, navShell) => HomeShell(navShell),
      branches: [
        StatefulShellBranch(
          routes: [
            GoRoute(path: '/feed', builder: (c, s) => const FeedScreen()),
          ],
        ),
        StatefulShellBranch(
          routes: [
            GoRoute(path: '/alerts', builder: (c, s) => const AlertsScreen()),
          ],
        ),
      ],
    ),
  ],
);
