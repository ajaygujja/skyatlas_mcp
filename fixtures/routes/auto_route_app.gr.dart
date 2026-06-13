// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint

/// The generated auto_route table (§7.4): sometimes the only place the full
/// route list exists. Each PageRouteInfo subclass carries `static const name`
/// and a `PageInfo` whose builder returns the real screen widget.
class HomeRoute extends PageRouteInfo<void> {
  const HomeRoute({List<PageRouteInfo>? children})
      : super(HomeRoute.name, initialChildren: children);

  static const String name = 'HomeRoute';

  static PageInfo page = PageInfo(
    name,
    builder: (data) {
      return const HomeScreen();
    },
  );
}

class ProfileRoute extends PageRouteInfo<void> {
  const ProfileRoute({List<PageRouteInfo>? children})
      : super(ProfileRoute.name, initialChildren: children);

  static const String name = 'ProfileRoute';

  static PageInfo page = PageInfo(
    name,
    builder: (data) {
      return const ProfileScreen();
    },
  );
}
