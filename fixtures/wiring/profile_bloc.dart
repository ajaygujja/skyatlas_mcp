import 'package:bloc/bloc.dart';

import 'repositories.dart';

abstract class ProfileEvent {}

class ProfileState {}

class ProfileBloc extends Bloc<ProfileEvent, ProfileState> {
  ProfileBloc(this._repo) : super(ProfileState());

  final ProfileRepository _repo;

  Future<void> _onLoad(ProfileEvent event, Emitter<ProfileState> emit) async {
    emit(ProfileState());
    await _repo.name();
  }
}
