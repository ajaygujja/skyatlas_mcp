import 'package:flutter_bloc/flutter_bloc.dart';

import 'user_repository.dart';

sealed class UserEvent {}

final class LoadUser extends UserEvent {
  final String userId;
  LoadUser(this.userId);
}

final class RefreshUser extends UserEvent {}

class UserBloc extends Bloc<UserEvent, UserState> {
  final UserRepository _repository;

  UserBloc(this._repository) : super(const UserInitial()) {
    on<LoadUser>(_onLoad);
    on<RefreshUser>(_onRefresh);
  }

  Future<void> _onLoad(LoadUser event, Emitter<UserState> emit) async {
    emit(const UserLoading());
    final user = await _repository.fetchUser(event.userId);
    emit(UserLoaded(user));
  }

  Future<void> _onRefresh(RefreshUser event, Emitter<UserState> emit) async {
    final user = await _repository.fetchUser(state.userId);
    emit(UserLoaded(user));
  }
}
