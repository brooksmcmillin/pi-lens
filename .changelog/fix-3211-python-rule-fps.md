---
section: Fixed
---

- **Three Python ast-grep rules no longer false-positive (closes #3211)** —
  `no-boolean-in-except` stops its `boolean_operator` search at the handler's
  own block, so an `or`/`and` inside the handler *body* (`return 2 or 3`) is
  no longer mistaken for a boolean exception-type condition.
  `no-http-headers-bracket-access` now excludes `headers[...]` writes
  (`resp.headers["X"] = v`, `+=`, `del`) — only reads can raise `KeyError`.
  `unchecked-throwing-call-python`'s `int()`/`float()` patterns moved to a
  new `unchecked-numeric-parse-python` rule (`warning` severity) that also
  excludes numeric-literal and already-numeric-constructor (`int`/`float`/
  `Decimal`) arguments.
