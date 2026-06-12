import 'package:bloc/bloc.dart';

sealed class UserEvent {}

class LoadUser extends UserEvent {}

class UserBloc extends Bloc<UserEvent, int> {
  UserBloc() : super(0) {
    on<LoadUser>(_onLoad);
  }

  Future<void> _onLoad(LoadUser event, Emitter<int> emit) async {
    emit(1);
  }
}
