import 'form_repository.dart';

// Holds the repository as an interface type; the concrete implementation (and the
// datasource it carries) is only reachable by following the interface.
class GetFormsCountUsecase {
  GetFormsCountUsecase(this.repository);

  final FormRepository repository;
}
