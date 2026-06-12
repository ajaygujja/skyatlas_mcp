import 'package:flutter_bloc/flutter_bloc.dart';

import 'user_repository.dart';

sealed class UserEvent {}

final class LoadUser extends UserEvent {
  final String userId;
  LoadUser(this.userId);
}

final class RefreshUser extends UserEvent {}

sealed class UserState {}

class UserInitial extends UserState {}

class UserLoading extends UserState {}

class UserLoaded extends UserState {
  final User user;
  UserLoaded(this.user);
}

/// A two-type-arg Bloc: event + state. Handlers registered both as a method
/// reference (`_onLoad`) and as an inline closure.
class UserBloc extends Bloc<UserEvent, UserState> {
  final UserRepository _repository;

  UserBloc(this._repository) : super(UserInitial()) {
    on<LoadUser>(_onLoad);
    on<RefreshUser>((event, emit) async {
      final user = await _repository.fetchUser(state.userId);
      emit(UserLoaded(user));
    });
  }

  Future<void> _onLoad(LoadUser event, Emitter<UserState> emit) async {
    emit(UserLoading());
    final user = await _repository.fetchUser(event.userId);
    emit(UserLoaded(user));
  }
}
