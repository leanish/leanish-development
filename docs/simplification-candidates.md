# Simplification candidates

Code that covers rare cases and could be removed to keep the tools simpler, with what removing it would give up.
Nothing here is planned for removal; each entry is a debate to have when the cost of keeping it shows up (a bug in
it, a change it slows down).

Each entry says what the code protects, what it costs, what removing it would give up, and the simpler alternative.

## The parsed check of strict pins in inactive branches

- **Where:** `strictPinsChanged` in [`edit-checks.ts`](../packages/remediation/src/edit-checks.ts), with
  [`strict-calls.ts`](../packages/remediation/src/strict-calls.ts) and
  [`StrictCalls.java`](../packages/remediation/gradle/StrictCalls.java) for build scripts, `smol-toml` for catalogs.
- **What it protects:** Gradle `strictly(...)` pins in code Gradle doesn't run for the inventory, such as an
  `if (hasProperty("legacy")) { … }` branch. Pins Gradle does run are already protected by the inventory comparison,
  which uses Gradle itself; this check is the backstop for the ones it can't see.
- **What it costs:** a Java run per verified side (about a second), the build's own Gradle distribution in the tools'
  Gradle home, and a small Java program that walks Groovy's and Kotlin's syntax trees. It replaced, in 0.6.0, a
  hand-written lexer whose every missed language detail was a hole.
- **What removing it would give up:** an agent changing a strict pin in an inactive branch would no longer be caught
  by verification. The skills still tell the agent never to change strict pins, the plan never asks for it, and the
  owner sees the diff in the PR.
- **Simpler alternative:** refuse any edit to a file containing the word `strictly`. It needs no parser, but stops the
  tools from updating anything in a build that pins one dependency strictly.
