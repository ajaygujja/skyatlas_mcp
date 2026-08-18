import 'package:injectable/injectable.dart';

import 'contracts.dart';

/// Every reference kind in one place: an annotation, a supertype, a field type,
/// a construction, a static access, a bare mention and calls of both shapes.
@LazySingleton(as: FormRepository)
class FormRepositoryImpl implements FormRepository {
  FormRepositoryImpl(this._client);

  final ApiClient _client;

  Future<FormEntity> load(String id) async {
    final payload = await _client.send(Endpoints.forms);
    final entity = FormEntity.fromJson(payload);
    final buffer = StringBuffer()..write(entity.title);
    logLine(buffer.toString());
    return entity;
  }

  bool isForm(Object value) => value is FormEntity;

  Type get binding => FormRepository;
}

void logLine(String line) {}
