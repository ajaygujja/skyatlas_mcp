enum UserRole { admin, member, guest }

typedef Json = Map<String, dynamic>;

class User {
  final String id;
  final String name;
  final UserRole role;
  static const int maxNameLength = 80;

  const User({required this.id, required this.name, this.role = UserRole.member});

  User.guest()
      : id = '',
        name = 'Guest',
        role = UserRole.guest;

  factory User.fromJson(Json json) {
    return User(
      id: json['id'] as String,
      name: json['name'] as String,
    );
  }

  bool get isAdmin => role == UserRole.admin;

  Json toJson() => {'id': id, 'name': name, 'role': role.name};
}

extension type UserId(String value) {
  bool get isValid => value.isNotEmpty;
}
