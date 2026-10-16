/** Pin source repository discovery to v0.5.2, including its known limitations. */
export const githubRepositoryCases: ReadonlyArray<readonly [unknown, string | undefined]> = [
  // Manifest and transport spellings, including every direct v0.5.2 case.
  [{ type: "git", url: "git+https://github.com/7rulnik/source-map-js.git" }, "7rulnik/source-map-js"],
  // Known limit: numeric URL ports are read as owners; numeric scp owners must stay readable.
  ["git+ssh://git@github.com:22/acme/lib.git", "22/acme"],
  ["ssh://git@github.com:2222/Acme/Lib.git#main", "2222/acme"],
  ["https://github.com:443/acme/lib", "443/acme"],
  ["git@github.com:acme/lib.git", "acme/lib"],
  ["git@github.com:22/acme.git", "22/acme"],
  ["git@github.com:1234/lib.git", "1234/lib"],
  ["ssh://git@ssh.github.com/acme/lib.git", "acme/lib"],
  ["https://github.com/22/acme.git", "22/acme"],
  ["git+ssh://git@github.com:acme/lib.git", "acme/lib"],
  ["ssh://git@github.com:acme/lib.git", "acme/lib"],
  ["https://github.com:acme/lib", "acme/lib"],
  ["scm:git:ssh://github.com:acme/lib", "acme/lib"],
  [" https://github.com/acme/lib", "acme/lib"],
  ["\thttps://github.com/acme/lib", "acme/lib"],
  // Known limit: surrounding whitespace is not trimmed; trailing whitespace can prevent a match.
  ["\nhttps://github.com/acme/lib.git \t\n", undefined],
  [" acme/lib.git ", undefined],
  [{ url: " \tgit+ssh://git@github.com:22/acme/lib.git\n" }, "22/acme"],
  // Keep v0.5.2's readable scheme spellings, even when the separators are malformed.
  ...["https:", "https:/", "https:///", "https:\\\\", "scm:git:", "scm:git:ssh:/\\/\\"].flatMap((prefix) =>
    ["", "git@"].flatMap((user) =>
      ["", ":22"].map((port): readonly [string, string] => [`${prefix}${user}github.com${port}/Acme/Lib.git`, port === "" ? "acme/lib" : "22/acme"]))),
  ["git+ssh://git@github.com/Acme/Lib.git#main", "acme/lib"],
  ["scm:git:git@github.com:FasterXML/jackson-databind.git", "fasterxml/jackson-databind"],
  ["https://github.com/aws/aws-sdk-js-v3/tree/main/clients/client-s3", "aws/aws-sdk-js-v3"],
  ["https://www.github.com/Acme/Lib", "acme/lib"],
  // Known limit: github.com is matched inside lookalike hosts and paths, without a host boundary.
  ["https://notgithub.com/acme/lib", "acme/lib"],
  ["git+ssh://git@notgithub.com:22/acme/lib.git", "22/acme"],
  ["https://evil.example/github.com:443/acme/lib", "443/acme"],
  ["git+https://evilgithub.com/acme/lib.git", "acme/lib"],
  ["https://evil.example/github.com/victim/repo", "victim/repo"],
  ["git://github.com/Acme/Lib.git", "acme/lib"],
  ["github:acme/lib", "acme/lib"],
  ["acme/lib", "acme/lib"],
  ["https://gitlab.com/acme/lib", undefined],
  [undefined, undefined],
  // SCM connections and userinfo spellings read by v0.5.2.
  ["scm:git:github.com:acme/lib.git", "acme/lib"],
  ["https://user%40corp@github.com/acme/lib", "acme/lib"],
  ["https://@github.com/acme/lib", "acme/lib"],
  ["scm:git@github.com:xerial/snappy-java.git", "xerial/snappy-java"],
  ["//github.com/acme/lib", "acme/lib"],
  ["scm:git://github.com/acme/lib", "acme/lib"],
  ["scm:git://user%40corp@www.github.com:443/acme/lib", "443/acme"],
  // Transports, SCM prefixes, userinfo, www and explicit ports vary independently.
  ...["", "scm:git:", "scm:git:ssh://", "scm:git:https://", "git+ssh://", "ssh://", "https://", "http://"].flatMap((prefix) =>
    ["", "git@", "user%40corp:pass%3Aword@"].flatMap((user) =>
      ["github.com", "www.github.com"].flatMap((host) =>
        ["", ":443"].map((port): readonly [string, string] => [`${prefix}${user}${host}${port}/Acme/Lib.git#main`, port === "" ? "acme/lib" : "443/acme"])))),
  ...["", "scm:git:", "scm:git:ssh:"].flatMap((prefix) =>
    ["", "git@", "user%40corp@"].flatMap((user) =>
      ["github.com", "www.github.com"].map((host): readonly [string, string] => [`${prefix}${user}${host}:Acme/Lib.git#main`, "acme/lib"]))),
  ["HTTPS://USER%40CORP@WWW.GITHUB.COM:443/Acme/Lib.git?ref=main", "443/acme"],
  // Known limit: subdomains, paths, queries and fragments can all supply the github.com substring.
  ["https://github.com.evil.example/acme/lib", undefined],
  ["https://sub.github.com/acme/lib", "acme/lib"],
  ["notgithub.com/acme/lib", "acme/lib"],
  ["evilgithub.com:acme/lib", "acme/lib"],
  ["/github.com/acme/lib", "acme/lib"],
  ["\\github.com/acme/lib", "acme/lib"],
  ["https://evil.example?x=github.com/acme/lib", "acme/lib"],
  ["https://evil.example#github.com/acme/lib", "acme/lib"],
  ["scm:git:notgithub.com:acme/lib.git", "acme/lib"],
  ["scm:git:ssh://git@notgithub.com/acme/lib.git", "acme/lib"],
  ["https://github.com@evil.example/acme/lib", undefined],
  ["https://evil.example/?repo=github.com/acme/lib", "acme/lib"],
  ["https://evil.example/?repo=https://github.com/acme/lib", "acme/lib"],
  ["https://evil.example/#https://github.com/acme/lib", "acme/lib"],
  ["https://evil.example//github.com/acme/lib", "acme/lib"],
  ["https://evil.example/git@github.com:acme/lib.git", "acme/lib"],
  ["https://evil.example/path@github.com/acme/lib", "acme/lib"],
  ["https://evil.example\\@github.com/acme/lib", "acme/lib"],
  ["https://evil.example\\path@github.com/acme/lib", "acme/lib"],
  ["https://evil.example/https://github.com/acme/lib", "acme/lib"],
  ["scm:git:https://evil.example/github.com/acme/lib", "acme/lib"],
  [{ url: 42 }, undefined],
  [null, undefined],
];
