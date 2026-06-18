// A second class sharing CounterRepository's name, in a file the cubit does not
// import. Its symbol id sorts before repositories.dart, so the lowest-id default
// would land the chain here; import-bias must follow the cubit's import instead.
class CounterRepository {
  Future<int> load() async => 1;
}
