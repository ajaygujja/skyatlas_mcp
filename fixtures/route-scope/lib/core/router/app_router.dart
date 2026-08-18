import 'package:go_router/go_router.dart';

import '../../features/billing/presentation/invoice_screen.dart';
import '../../features/orders/presentation/orders_screen.dart';
import 'package:shared_ui/support_screen.dart';

/// The layout this fixture exists for: one central table declaring every route,
/// with the screens living in the feature folders and packages the routes are
/// scoped by. Attributing a route to the file declaring it would put the whole
/// app in `core/router`.
final GoRouter appRouter = GoRouter(
  routes: [
    GoRoute(
      path: '/invoices',
      name: 'invoices',
      builder: (context, state) => const InvoiceScreen(),
      routes: [
        GoRoute(
          path: 'detail',
          builder: (context, state) => const InvoiceDetailScreen(),
        ),
      ],
    ),
    ShellRoute(
      builder: (context, state, child) => AppShell(child: child),
      routes: [
        GoRoute(
          path: '/orders',
          redirect: orderGuard,
          builder: (context, state) => const OrdersScreen(),
        ),
      ],
    ),
    GoRoute(
      path: '/support',
      builder: (context, state) => const SupportScreen(),
    ),
  ],
);

String? orderGuard(context, state) => null;
