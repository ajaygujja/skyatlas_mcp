/// The declarations service.dart references, so the sites resolve to something.
abstract class FormRepository {
  Future<FormEntity> load(String id);
}

class ApiClient {
  Future<Map<String, Object?>> send(String path) async => {};
}

class FormEntity {
  FormEntity(this.title);
  factory FormEntity.fromJson(Map<String, Object?> json) => FormEntity('');
  final String title;
}

class Endpoints {
  static const forms = '/forms';
}

/// A typedef: its own name is a type_identifier in a declaring position, so it
/// must not count as a reference to itself.
typedef FormLoader = Future<FormEntity> Function(String id);
