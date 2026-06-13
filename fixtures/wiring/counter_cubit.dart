import 'package:bloc/bloc.dart';

import 'repositories.dart';

class CounterCubit extends Cubit<int> {
  CounterCubit(this._repo) : super(0);

  final CounterRepository _repo;

  Future<void> load() async => emit(await _repo.load());
}
