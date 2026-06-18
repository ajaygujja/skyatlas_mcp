import 'package:bloc/bloc.dart';

import 'usecases.dart';

abstract class FormsEvent {}

class FormsState {}

// A clean-architecture bloc whose sole dependency is a use-case; the repository
// and datasource sit further down the chain, behind the use-case.
class ConstructionFormsBloc extends Bloc<FormsEvent, FormsState> {
  ConstructionFormsBloc(this._getCounts) : super(FormsState());

  final GetFormsCountUsecase _getCounts;
}
