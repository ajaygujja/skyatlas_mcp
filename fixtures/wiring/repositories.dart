// Repository layer — the leaf of the wiring chain. A bloc whose constructor or
// field type name resolves to one of these classes gets a syntactic repo edge.
class CounterRepository {
  Future<int> load() async => 0;
}

class ProfileRepository {
  Future<String> name() async => 'anon';
}
