import 'form_datasource.dart';

abstract class FormRepository {
  Future<int> count();
}

// The concrete repository; the datasource lives here, not on the interface, so the
// chain only reaches it once the interface is followed to this implementor.
class FormRepositoryImpl implements FormRepository {
  FormRepositoryImpl(this._datasource);

  final FormDatasource _datasource;

  @override
  Future<int> count() => _datasource.fetchCount();
}
