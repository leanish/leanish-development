# Simplification candidates

No open candidates are recorded.

## Completed: strict pins through Gradle

The owner chose to remove the separate source-parser check. Strict pins are protected by Gradle's inventory and the
[planned reference comparison](../packages/remediation/src/gradle-reference.ts), which compare interpreted strict
declarations and strict constraints, including those supplied by catalogs.

Pins Gradle doesn't resolve, such as an inactive branch or unused catalog entry, aren't checked. This is a deliberate
scope choice: the agent's instructions still forbid changing them, and the owner reviews the PR diff. The separate
Java parser, compiler downloads, protected parser state and catalog comparison are gone.
