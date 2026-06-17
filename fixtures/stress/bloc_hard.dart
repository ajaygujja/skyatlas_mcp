// Stress fixture: Bloc internals + sealed events (Dart 3).
// Run: pnpm tsx scripts/repro-extract.ts fixtures/stress/bloc_hard.dart blocs
import 'package:flutter_bloc/flutter_bloc.dart';

sealed class CounterEvent {}
final class Increment extends CounterEvent {}
final class Decrement extends CounterEvent {}
final class SetTo extends CounterEvent {
  SetTo(this.value);
  final int value;
}

class CounterState {
  const CounterState(this.count);
  final int count;
}

class CounterBloc extends Bloc<CounterEvent, CounterState> {
  CounterBloc(this._repo) : super(const CounterState(0)) {
    on<Increment>(_onIncrement);
    on<Decrement>((event, emit) => emit(CounterState(state.count - 1)));
    on<SetTo>(_onSetTo);
  }

  final CounterRepository _repo;

  Future<void> _onIncrement(Increment event, Emitter<CounterState> emit) async {
    final next = await _repo.bump(state.count);
    emit(CounterState(next));
  }

  void _onSetTo(SetTo event, Emitter<CounterState> emit) {
    emit(CounterState(event.value));
  }
}

class TallyCubit extends Cubit<int> {
  TallyCubit(this._repo) : super(0);
  final CounterRepository _repo;
  void add() => emit(state + 1);
  Future<void> load() async => emit(await _repo.bump(0));
}
