import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:hydrated_bloc/hydrated_bloc.dart';

/// A plain Cubit: single type arg = state only, no event type.
class CounterCubit extends Cubit<int> {
  CounterCubit() : super(0);

  void increment() => emit(state + 1);

  void reset() {
    emit(0);
  }
}

/// A custom base ending in `Cubit` still classifies as a cubit (suffix rule).
class SettingsCubit extends HydratedCubit<SettingsState> {
  SettingsCubit() : super(const SettingsState());

  void toggleDarkMode() {
    emit(state.copyWith(dark: !state.dark));
  }
}
