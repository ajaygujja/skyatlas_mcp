// Stress fixture: go_router patterns beyond a single real repo.
// Run: pnpm tsx scripts/repro-extract.ts fixtures/stress/go_router_hard.dart routes
import 'package:go_router/go_router.dart';
import 'package:flutter/material.dart';

final router = GoRouter(
  initialLocation: '/',
  // Top-level auth redirect — a guard the graph should surface.
  redirect: (context, state) => authGuard(state),
  routes: [
    // String-literal path + string-literal name (BOTH should resolve cleanly).
    GoRoute(
      path: '/login',
      name: 'login',
      builder: (context, state) => const LoginScreen(),
    ),
    // Nested relative paths: child '/dashboard' + 'settings' → /dashboard/settings.
    GoRoute(
      path: '/dashboard',
      name: 'dashboard',
      redirect: requireAuth,
      routes: [
        GoRoute(
          path: 'settings',
          name: 'settings',
          builder: (context, state) => const SettingsScreen(),
        ),
        // Path param.
        GoRoute(
          path: 'user/:id',
          name: 'user',
          builder: (context, state) => UserScreen(id: state.pathParameters['id']!),
        ),
      ],
    ),
    // ShellRoute with a builder that wraps the child navigator.
    ShellRoute(
      builder: (context, state, child) => ScaffoldShell(child: child),
      routes: [
        GoRoute(
          path: '/feed',
          name: 'feed',
          builder: (context, state) => const FeedScreen(),
        ),
      ],
    ),
    // Route built via collection-for over a list — dynamic, must be honest.
    for (final tab in tabs)
      GoRoute(path: tab.path, builder: (context, state) => TabScreen(tab: tab)),
    // pageBuilder instead of builder (transition pages).
    GoRoute(
      path: '/modal',
      name: 'modal',
      pageBuilder: (context, state) => const MaterialPage(child: ModalScreen()),
    ),
  ],
);
