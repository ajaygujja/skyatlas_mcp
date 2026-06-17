// Generated companion (*.gr.dart) — PageInfo builders resolve Route → Screen.
import 'package:auto_route/auto_route.dart';

class LoginRoute extends PageRouteInfo<void> {
  const LoginRoute() : super(LoginRoute.name);
  static const String name = 'LoginRoute';
  static PageInfo page = PageInfo(name, builder: (data) => const LoginScreen());
}

class DashboardRoute extends PageRouteInfo<void> {
  const DashboardRoute() : super(DashboardRoute.name);
  static const String name = 'DashboardRoute';
  static PageInfo page = PageInfo(name, builder: (data) => const DashboardScreen());
}

class SettingsRoute extends PageRouteInfo<void> {
  const SettingsRoute() : super(SettingsRoute.name);
  static const String name = 'SettingsRoute';
  static PageInfo page = PageInfo(name, builder: (data) => const SettingsScreen());
}

class ProfileRoute extends PageRouteInfo<void> {
  const ProfileRoute() : super(ProfileRoute.name);
  static const String name = 'ProfileRoute';
  static PageInfo page = PageInfo(name, builder: (data) => const ProfileScreen());
}
