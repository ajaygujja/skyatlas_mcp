/**
 * String-const extractor: collects compile-time string constants so the route
 * graph can resolve const path references (`path: RoutePaths.home` → "/home")
 * instead of dropping or labelling them as shells (§5.1 honesty, fallback to
 * verbatim when a value cannot be resolved).
 *
 * Pure: CST in → data out, no I/O (§9.1). Scope is deliberately narrow — only
 * declarations whose initializer is a single `string_literal`:
 *  - class fields:  `class RoutePaths { static const home = '/home'; }`
 *  - top-level:     `const homePath = '/home';`
 *
 * Both a class-qualified key (`RoutePaths.home`) and the bare field name (`home`)
 * are emitted; the qualified form is preferred at lookup, the bare form is the
 * fallback. Bare collisions keep the first value seen — acceptable for display
 * resolution that already degrades gracefully to verbatim text.
 *
 * Enum-backed route paths (B6/N1): real apps declare
 *   enum AppRoutes { splash('/splash'); const AppRoutes(this.path); final String path; }
 * and reference `AppRoutes.splash.path`. Each enum value's positional ctor args
 * are mapped by position to the ctor's parameter names, and emitted under the
 * fully-qualified key `AppRoutes.splash.path` → "/splash". The value's own name
 * is emitted as `AppRoutes.splash.name` → "splash" (N1). Only fully-qualified
 * keys are emitted for enums (no bare fallback) since `path`/`name` collide
 * across every enum; the route resolver looks up the qualified `pathExpr` first.
 *
 * Node names below were observed via scripts/dump-tree.ts against
 * tree-sitter-dart @ a9bdfa3 (vendor/GRAMMAR_VERSION), per Working Rule 2:
 *   (static_final_declaration (identifier 'home') (string_literal "'/home'"))
 *   (enum_declaration (identifier 'AppRoutes') (enum_body
 *     (enum_constant (identifier 'splash')
 *       (argument_part (arguments (argument (string_literal "'/splash'")))))
 *     (declaration (constant_constructor_signature (identifier 'AppRoutes')
 *       (formal_parameter_list (formal_parameter
 *         (constructor_param (this) (identifier 'path'))))))))
 */
import type { Node, Tree } from 'web-tree-sitter';

/** `RoutePaths.home` / `home` → resolved string value (quotes stripped). */
export type StringConsts = Record<string, string>;

export function extractStringConsts(tree: Tree): StringConsts {
  const out: StringConsts = {};
  walk(tree.rootNode, undefined, out);
  return out;
}

function walk(node: Node, enclosingClass: string | undefined, out: StringConsts): void {
  let scope = enclosingClass;
  if (node.type === 'class_definition') {
    scope = node.namedChildren.find((c) => c.type === 'identifier')?.text;
  }
  if (node.type === 'enum_declaration') {
    extractEnum(node, out);
    return; // enum-value fields handled here; do not recurse into the body
  }
  if (node.type === 'static_final_declaration') {
    const name = node.namedChildren.find((c) => c.type === 'identifier')?.text;
    const lit = node.namedChildren.find((c) => c.type === 'string_literal');
    if (name && lit) {
      const value = stripQuotes(lit.text);
      if (scope) {
        out[`${scope}.${name}`] = value;
      }
      if (!(name in out)) out[name] = value;
    }
  }
  for (const child of node.namedChildren) walk(child, scope, out);
}

/**
 * Maps each enum value's positional string args to the enum constructor's
 * parameter names, emitting `Enum.value.field` keys (B6) plus `Enum.value.name`
 * (N1). Non-string args (e.g. `low(0)`) are skipped — this map is string-only.
 */
function extractEnum(node: Node, out: StringConsts): void {
  const enumName = node.namedChildren.find((c) => c.type === 'identifier')?.text;
  const body = node.namedChildren.find((c) => c.type === 'enum_body');
  if (!enumName || !body) return;

  const paramNames = enumCtorParamNames(body);

  for (const ctor of body.namedChildren) {
    if (ctor.type !== 'enum_constant') continue;
    const valueName = ctor.namedChildren.find((c) => c.type === 'identifier')?.text;
    if (!valueName) continue;

    // N1: the value's own identifier resolves `Enum.value.name`.
    out[`${enumName}.${valueName}.name`] = valueName;

    // B6: positional string args mapped to ctor param names.
    const args = ctor.namedChildren
      .find((c) => c.type === 'argument_part')
      ?.namedChildren.find((c) => c.type === 'arguments');
    if (!args) continue;
    let pos = 0;
    for (const arg of args.namedChildren) {
      if (arg.type !== 'argument') continue;
      const field = paramNames[pos];
      pos++;
      const lit = arg.namedChildren.find((c) => c.type === 'string_literal');
      if (field && lit) out[`${enumName}.${valueName}.${field}`] = stripQuotes(lit.text);
    }
  }
}

/**
 * Ordered field names of the enum's const ctor (`const AppRoutes(this.path)` →
 * ["path"]). Dart enum ctors are always `const` and use initializing formals
 * (`this.x`), so only the dumped `constant_constructor_signature` →
 * `formal_parameter` → `constructor_param` → trailing `identifier` shape is
 * handled (Working Rule 2 — no unverified shapes).
 */
function enumCtorParamNames(body: Node): string[] {
  for (const decl of body.namedChildren) {
    if (decl.type !== 'declaration') continue;
    const sig = decl.namedChildren.find((c) => c.type === 'constant_constructor_signature');
    const params = sig?.namedChildren.find((c) => c.type === 'formal_parameter_list');
    if (!params) continue;
    return params.namedChildren
      .filter((p) => p.type === 'formal_parameter')
      .map((p) => {
        const param = p.namedChildren.find((c) => c.type === 'constructor_param');
        const ids = param?.namedChildren.filter((c) => c.type === 'identifier') ?? [];
        return ids[ids.length - 1]?.text ?? '';
      });
  }
  return [];
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, '');
}
