/// A bloc demonstrating every declaration-detail field Phase 2 extracts.
/// Second doc line — only the first should land in `doc`.
@immutable
@RoutePage(name: 'DetailRoute')
abstract base class DetailBloc<E, S extends Object>
    extends Bloc<DetailEvent, DetailState>
    with LoggerMixin
    implements Disposable, Comparable<DetailBloc<E, S>> {
  static const int maxRetries = 3;
  late final String? _label;

  /// Creates the bloc.
  const DetailBloc(this._label, {required Repo repo, int retries = 2});

  factory DetailBloc.standard() => throw UnimplementedError();

  @override
  Future<void> load(String id, [int depth = 0]) async {}

  static String format(num value) => '$value';

  String get title => _label ?? '';
  set title(String v) {}
}

sealed class Shape {}

enum Status with Describable implements Comparable<Status> {
  active,
  inactive;

  @override
  int compareTo(Status other) => index - other.index;
}

/// Fetches everything eagerly when [eager] is set.
@Deprecated('use fetchSome')
Future<List<int>> fetchAll<T>(T seed, {bool eager = false}) async => [];

void onEach(void Function(int) callback, [String? label]) {}

typedef JsonMap = Map<String, dynamic>;

const Duration kTimeout = Duration(seconds: 5);
