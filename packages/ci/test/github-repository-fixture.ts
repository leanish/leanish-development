/** Shared input table for parser regressions and differential checks against earlier releases. */
export const githubRepositoryCases: ReadonlyArray<readonly [unknown, string | undefined]> = [
  // Every direct githubRepository case in v0.5.2 and rc.6.
  [{ type: "git", url: "git+https://github.com/7rulnik/source-map-js.git" }, "7rulnik/source-map-js"],
  ["git+ssh://git@github.com:22/acme/lib.git", "acme/lib"],
  ["ssh://git@github.com:2222/Acme/Lib.git#main", "acme/lib"],
  ["https://github.com:443/acme/lib", "acme/lib"],
  ["git@github.com:acme/lib.git", "acme/lib"],
  ["git@github.com:22/acme.git", "22/acme"],
  ["git+ssh://git@github.com/Acme/Lib.git#main", "acme/lib"],
  ["scm:git:git@github.com:FasterXML/jackson-databind.git", "fasterxml/jackson-databind"],
  ["https://github.com/aws/aws-sdk-js-v3/tree/main/clients/client-s3", "aws/aws-sdk-js-v3"],
  ["https://www.github.com/Acme/Lib", "acme/lib"],
  ["https://notgithub.com/acme/lib", undefined],
  ["git+ssh://git@notgithub.com:22/acme/lib.git", undefined],
  ["https://evil.example/github.com:443/acme/lib", undefined],
  ["git+https://evilgithub.com/acme/lib.git", undefined],
  ["https://evil.example/github.com/victim/repo", undefined],
  ["git://github.com/Acme/Lib.git", "acme/lib"],
  ["github:acme/lib", "acme/lib"],
  ["acme/lib", "acme/lib"],
  ["https://gitlab.com/acme/lib", undefined],
  [undefined, undefined],
  // The two rc.6 regressions and the older POM connection spelling.
  ["scm:git:github.com:acme/lib.git", "acme/lib"],
  ["https://user%40corp@github.com/acme/lib", "acme/lib"],
  ["https://@github.com/acme/lib", "acme/lib"],
  ["scm:git@github.com:xerial/snappy-java.git", "xerial/snappy-java"],
  ["//github.com/acme/lib", "acme/lib"],
  ["scm:git://github.com/acme/lib", "acme/lib"],
  ["scm:git://user%40corp@www.github.com:443/acme/lib", "acme/lib"],
  // Transports, SCM prefixes, userinfo, www and explicit ports vary independently.
  ...["", "scm:git:", "scm:git:ssh://", "scm:git:https://", "git+ssh://", "ssh://", "https://", "http://"].flatMap((prefix) =>
    ["", "git@", "user%40corp:pass%3Aword@"].flatMap((user) =>
      ["github.com", "www.github.com"].flatMap((host) =>
        ["", ":443"].map((port): readonly [string, string] => [`${prefix}${user}${host}${port}/Acme/Lib.git#main`, "acme/lib"])))),
  ...["", "scm:git:", "scm:git:ssh:"].flatMap((prefix) =>
    ["", "git@", "user%40corp@"].flatMap((user) =>
      ["github.com", "www.github.com"].map((host): readonly [string, string] => [`${prefix}${user}${host}:Acme/Lib.git#main`, "acme/lib"]))),
  ["HTTPS://USER%40CORP@WWW.GITHUB.COM:443/Acme/Lib.git?ref=main", "acme/lib"],
  ["https://github.com.evil.example/acme/lib", undefined],
  ["https://sub.github.com/acme/lib", undefined],
  ["scm:git:notgithub.com:acme/lib.git", undefined],
  ["scm:git:ssh://git@notgithub.com/acme/lib.git", undefined],
  ["https://github.com@evil.example/acme/lib", undefined],
  ["https://evil.example/?repo=github.com/acme/lib", undefined],
  ["https://evil.example/?repo=https://github.com/acme/lib", undefined],
  ["https://evil.example/#https://github.com/acme/lib", undefined],
  ["https://evil.example//github.com/acme/lib", undefined],
  ["https://evil.example/git@github.com:acme/lib.git", undefined],
  ["https://evil.example/path@github.com/acme/lib", undefined],
  ["https://evil.example\\@github.com/acme/lib", undefined],
  ["https://evil.example\\path@github.com/acme/lib", undefined],
  ["https://evil.example/https://github.com/acme/lib", undefined],
  ["scm:git:https://evil.example/github.com/acme/lib", undefined],
  [{ url: 42 }, undefined],
  [null, undefined],
];
