// Global Riverpod providers — every declaration shape the extractor must read.
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'models.dart';

// Single type arg → grammar mis-parse (relational_expression).
final counterProvider = StateProvider<int>((ref) => 0);

// Single type arg, no `.` chain.
final userProvider = Provider<User>((ref) => User());

// Chained `.autoDispose` before a single type arg — still mis-parses.
final asyncUserProvider = FutureProvider.autoDispose<User>((ref) async => fetchUser());

// `.family` with two type args → parses cleanly (≥2 type args).
final userByIdProvider = Provider.family<User, String>((ref, id) => User());

// Two type args, no chain → parses cleanly.
final userNotifierProvider = NotifierProvider<UserNotifier, UserState>(UserNotifier.new);

// No type args at all → clean identifier + argument_part.
final loggerProvider = Provider((ref) => Logger());

// Not a provider: a plain final must be ignored.
final appName = 'demo';
