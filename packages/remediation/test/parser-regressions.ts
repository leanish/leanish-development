/** Real-parser regressions shared by the edit guard and both tools' verification tests. */
const emoji = "😀".repeat(16);
const groovy = `if (false) { dependencies { implementation("g:a") { version { def pad = "${emoji}"; strictly("1.0") } } } }\n`;
const kotlin = `if (false) { dependencies { implementation("g:a") { version { val pad = "${emoji}"; strictly("1.0") } } } }\n`;
const chain = 'if (false) { dependencies.create("g:a").version { strictly("1.0") } }\n';

export const PARSER_REGRESSIONS = [
  { name: "Groovy non-BMP columns", path: "build.gradle", before: groovy, after: groovy.replace("1.0", "2.0") },
  { name: "Kotlin non-BMP offsets", path: "build.gradle.kts", before: kotlin, after: kotlin.replace("1.0", "2.0") },
  { name: "Groovy enclosing receiver", path: "build.gradle", before: chain, after: chain.replace("g:a", "g:b") },
  { name: "Kotlin enclosing receiver", path: "build.gradle.kts", before: chain, after: chain.replace("g:a", "g:b") },
] as const;
