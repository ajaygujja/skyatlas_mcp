import 'package:hydrated_bloc/hydrated_bloc.dart';

/// A custom base ending in `Bloc` classifies as a bloc (suffix rule); event +
/// state type args still resolve from the superclass.
class AuthBloc extends HydratedBloc<AuthEvent, AuthState> {
  AuthBloc() : super(const Unauthenticated()) {
    on<LoggedIn>(_onLoggedIn);
    on<LoggedOut>(_onLoggedOut);
  }

  void _onLoggedIn(LoggedIn event, Emitter<AuthState> emit) {
    emit(Authenticated(event.token));
  }

  void _onLoggedOut(LoggedOut event, Emitter<AuthState> emit) {
    emit(const Unauthenticated());
  }
}
