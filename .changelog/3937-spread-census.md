---
section: Changed
audience: internal
---

- Narrow the mutation-bridge epoch/lineage census to its provable floor: an
  object-valued binding is OPAQUE, so the fold proves the `lineage` VALUE only
  for an expression written at the call site (a literal, a constructor, an
  explicit `undefined`/`void 0`, or a conditional/`??` of those), never for a
  name. Any heap alias carrier — a property value, an array element, an
  assignment RHS, a conditional arm, a destructuring source, a nested argument,
  a reflective member mutation, or a bare alias — can no longer read `safe`
  beside an epoch. The `const b = a` alias fixed point, the unknown-callee
  escape rule, the `Object.assign` fold, and the value-binding follow (with the
  binding-resolution machinery that kept it) are deleted, because the opaque
  default subsumes them and a name cannot be trusted to denote the declaration
  a `variable_declarator`-only scan found (R5-1). Every annotation stays MAYBE
  (no type resolver), a computed template key with a substitution and an
  undecoded escape are dynamic, and a `null` literal is not a defined proof.
  The reachable-profile bound (fourteen of sixteen) is pinned (#3937).
