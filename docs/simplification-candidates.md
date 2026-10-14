# Simplification candidates

Code that covers rare cases and could be removed to keep the tools simpler, with what removing it would give up.
Nothing here is planned for removal; each entry is a debate to have when the cost of keeping it shows up (a bug in
it, a change it slows down).

Each entry says what the code protects, what it costs, what removing it would give up, and the simpler alternative.

## The textual check of strict pins

- **Where:** `strictStatements` and the scanner it uses (`lineCode`, `balanceStrict`) in
  [`edit-checks.ts`](../packages/remediation/src/edit-checks.ts), called by `strictPinsChanged` during verification.
- **What it protects:** Gradle `strictly(...)` pins in code Gradle doesn't run for the inventory, such as an
  `if (hasProperty("legacy")) { … }` branch. Pins Gradle does run are already protected by the inventory comparison,
  which uses Gradle itself; this check is the backstop for the ones it can't see.
- **What it costs:** a hand-written scanner of Kotlin, Groovy and TOML text that skips strings and comments and
  balances brackets across continuation lines. Each language detail it misses is a hole; triple-quoted strings were
  one (fixed in 0.5.1).
- **What removing it would give up:** an agent changing a strict pin in an inactive branch would no longer be caught
  by verification. The skills still tell the agent never to change strict pins, the plan never asks for it, and the
  owner sees the diff in the PR.
- **Simpler alternative:** refuse any edit to a line containing the word `strictly`, wherever it is. It needs no
  scanner, but it misses a version written on a later line than `strictly(` and refuses edits to comments that
  mention it.
