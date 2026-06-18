import 'package:flutter_bloc/flutter_bloc.dart';

class ArrowBlocEvent {}
class ArrowBlocState {}

class ArrowBloc extends Bloc<ArrowBlocEvent, ArrowBlocState> {
  ArrowBloc() : super(ArrowBlocState());
}

class BlockBodyBlocEvent {}
class BlockBodyBlocState {}

class BlockBodyBloc extends Bloc<BlockBodyBlocEvent, BlockBodyBlocState> {
  BlockBodyBloc() : super(BlockBodyBlocState());
}
