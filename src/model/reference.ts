/**
 * Reference model (AI_FIX_SPEC.md §9.1): every site where a file names something
 * declared elsewhere.
 *
 * The symbol model answers "where is X declared"; this answers "who uses X",
 * which is the other half of code navigation and the question that otherwise
 * falls back to grep.
 *
 * Honesty rule (§5.1): a reference is a NAME as written at a site, never a
 * resolved binding. Two classes sharing a name share their references here, a
 * method call is attributed by name alone, and nothing distinguishes a call on
 * one receiver type from a call on another. Resolution — which declarations a
 * name matches, and whether that is ambiguous — happens in the index layer,
 * which is the only layer that can see the whole workspace.
 */

/**
 * The syntactic position a name was used in. Kinds are distinguished only where
 * the distinction changes what a caller would do about the site: a construction
 * or an annotation is a use of the declaration itself, a type reference is a
 * dependency in a signature, a call names a member rather than a type.
 */
export type ReferenceKind =
  /** A type position: parameter, field, return, supertype, type argument, `is`/`as`. */
  | 'typeRef'
  /** `Name(...)` at value position — a constructor invocation as written. */
  | 'constructs'
  /** `@Name` / `@Name(...)`. */
  | 'annotation'
  /** `Name.member`, including `Name.member()` and `Name.new`. */
  | 'staticAccess'
  /** A capitalized name mentioned with no call, member access or type position. */
  | 'nameRef'
  /** `name(...)`, `receiver.name(...)` or `..name(...)` — a call by member name. */
  | 'calls';

/** One site where a name is used. The file is implied by the entry holding it. */
export interface ReferenceSite {
  kind: ReferenceKind;
  /** 1-based line of the name token. */
  line: number;
  /**
   * Declaration enclosing the site — the class, mixin, enum or extension the
   * name was used inside. Absent at file scope (top-level functions and fields).
   */
  owner?: string;
  /**
   * Receiver text as written for a `calls` site (`repo`, `Foo`, `context`), which
   * is the only clue to what the call was made on: the receiver's type is not
   * resolved, and a cascade (`..name()`) has no receiver at the site at all.
   */
  receiver?: string;
}

/**
 * One file's references, keyed by the name used — the shape `StringConsts` uses,
 * for the same two reasons: it serializes into the disk cache as-is, and it
 * answers a lookup for one name without scanning the file's other sites.
 *
 * Keys are Dart identifiers, so they can collide with `Object.prototype` members
 * (`constructor`, `toString`); read them with `Object.hasOwn` rather than by
 * plain index access.
 */
export type FileReferences = Record<string, ReferenceSite[]>;
