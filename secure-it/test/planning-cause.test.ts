import { describe, expect, it } from "vitest";

import { planningCause } from "../src/planning-cause.ts";

describe("planningCause", () => {
  it("keeps the URL's registry and package path without userinfo, query credentials or fragments", () => {
    expect(planningCause("registry 502 from https://reader:password@registry.example/pkg?token=query-secret#private-fragment"))
      .toBe("registry 502 from https://registry.example/pkg");
  });

  it("redacts an unreadable URL rather than publishing its credentials", () => {
    expect(planningCause("registry 502 from https://reader:password@%"))
      .toBe("registry 502 from [redacted URL]");
  });

  it.each(["ghp_fake123", "gho_fake123", "ghu_fake123", "ghs_fake123", "ghr_fake123", "github_pat_fake123", "npm_fake123"])("redacts a %s token while keeping the failure", (token) => {
    expect(planningCause(`registry 502, credential=${token}; retry later`)).toBe("registry 502, credential=[redacted]; retry later");
  });

  it.each(["Bearer fake-secret", "bearer fake-secret", "Authorization: Basic fake-secret", "authorization: fake-secret"])("redacts %s", (header) => {
    expect(planningCause(`registry 502, ${header}`)).toBe(`registry 502, ${header.toLowerCase().startsWith("authorization") ? "Authorization:" : "Bearer"} [redacted]`);
  });

  it.each(["\n", "\r\n"])("publishes only the first line, leaving multiline file excerpts out (%j)", (newline) => {
    expect(planningCause(`registry 502${newline}private file contents: some-secret`)).toBe("registry 502");
  });

  it.each([
    ["password=fake-secret", "password=[redacted]"],
    ["PASSWORD=fake-secret", "PASSWORD=[redacted]"],
    ["passwd: fake-secret", "passwd: [redacted]"],
    ["pwd = fake-secret", "pwd = [redacted]"],
    ["client_secret=fake-secret", "client_secret=[redacted]"],
    // The name reads as an npm token too.
    ["NPM_TOKEN=fake-secret", "[redacted]=[redacted]"],
    ["GITHUB_TOKEN=fake-secret", "GITHUB_TOKEN=[redacted]"],
    ["//registry.example/:_authToken=fake-secret", "//registry.example/:_authToken=[redacted]"],
    ["//registry.example/:_auth=fake-secret", "//registry.example/:_auth=[redacted]"],
    ["api_key=fake-secret", "api_key=[redacted]"],
    ["x-api-key: fake-secret", "x-api-key: [redacted]"],
    ["apikey=fake-secret", "apikey=[redacted]"],
    ["private-key=fake-secret", "private-key=[redacted]"],
    ["aws_access_key=fake-secret", "aws_access_key=[redacted]"],
    ["credentials=fake-secret", "credentials=[redacted]"],
    ["token=\"fake secret\"", "token=[redacted]"],
    ["token='fake secret'", "token=[redacted]"],
    ["token=`fake secret`", "token=[redacted]"],
    ["token=\"fake \\\" secret\"", "token=[redacted]"],
    ["token=\"fake secret", "token=[redacted]"],
    ["\"password\":\"fake secret\"", "\"password\":[redacted]"],
    ["'password': 'fake secret'", "'password': [redacted]"],
    ["password:\"fake secret\"", "password:[redacted]"],
    ["token=fake,secret;tail", "token=[redacted]"],
    ["token: \"fake\"secret\"", "token: [redacted]"],
    ["password=\"prefix\"suffix", "password=[redacted]"],
    ["password='prefix'suffix", "password=[redacted]"],
    ["password=`prefix`suffix", "password=[redacted]"],
    ["[token]=fake-secret", "[token]=[redacted]"],
    ["[\"token\"]=fake-secret", "[\"token\"]=[redacted]"],
    ["token = fake-secret", "token = [redacted]"],
    ["authorization=fake-secret", "authorization=[redacted]"],
    ["authkey=fake-secret", "authkey=[redacted]"],
    ["passphrase=fake-secret", "passphrase=[redacted]"],
    ["sessionid=fake-secret", "sessionid=[redacted]"],
    ["cookie: fake-secret", "cookie: [redacted]"],
    ["jwt=fake-secret", "jwt=[redacted]"],
  ])("redacts the assignment %s", (assignment, redacted) => {
    expect(planningCause(`registry 502, ${assignment}`)).toBe(`registry 502, ${redacted}`);
  });

  it("stops an unquoted value where the assignment ends, keeping what follows", () => {
    expect(planningCause("password=fake-secret, retry=3; token=other-secret then gave up")).toBe("password=[redacted], retry=3; token=[redacted] then gave up");
  });

  it("stops a quoted value where the assignment ends, keeping what follows", () => {
    expect(planningCause("password=\"fake secret\", retry=3; token='other secret'; gave up")).toBe("password=[redacted], retry=3; token=[redacted]; gave up");
  });

  it("redacts an assignment that follows an ordinary label", () => {
    expect(planningCause("failed: password=fake-secret")).toBe("failed: password=[redacted]");
  });

  it("removes a URL's user and password in a scheme other than http", () => {
    expect(planningCause("can't reach postgres://reader:fake-secret@db.example/main")).toBe("can't reach postgres://db.example/main");
  });

  it("removes all of a URL's password when it contains an @", () => {
    expect(planningCause("unsupported git+ssh://reader:p@ss@github.com/acme/repo.git")).toBe("unsupported git+ssh://github.com/acme/repo.git");
  });

  it.each(["?ref=person@example.com", "#person@example.com"])("keeps the URL's host when %s also contains an @", (suffix) => {
    expect(planningCause(`unsupported git+ssh://reader:fake-secret@github.com${suffix}`)).toBe(`unsupported git+ssh://github.com${suffix}`);
  });

  it.each([
    "registry 502, retry=3",
    "author=someone at line: 12",
    "lockfile package-lock.json: entry@1.2.3 has version=1.2.3",
    "a Authentic=value and authors: many",
    "com.password4j:password4j:1.7 not found",
    "com.example:password-util:1.2.3 not found",
    "org.springframework.security:spring-security-token:5.0.1 not found",
    "@scope/token-utils@1.0.0 and left-pad@npm:token-helper@^1.0.0",
    "file:../secret-lib is missing",
    "invalid token:",
  ])("keeps the ordinary diagnostic %j", (diagnostic) => {
    expect(planningCause(diagnostic)).toBe(diagnostic);
  });

  it.each([
    ["max_tokens=4096 exceeded", "max_tokens=[redacted] exceeded"],
    ["invalid token: expired", "invalid token: [redacted]"],
    ["root@1.0.0: @fastify/cookie: no stable non-deprecated version satisfies ^1.0.0", "root@1.0.0: @fastify/cookie: [redacted] stable non-deprecated version satisfies ^1.0.0"],
  ])("errs toward redacting a word that only looks secret: %s", (diagnostic, redacted) => {
    expect(planningCause(diagnostic)).toBe(redacted);
  });

  it.each([
    ["password=several words here", "password=[redacted] words here"],
    ["--password fake-secret", "--password fake-secret"],
    ["token:fake-secret", "token:fake-secret"],
  ])("documents what an unquoted or unseparated value still shows: %s", (message, result) => {
    expect(planningCause(message)).toBe(result);
  });

  it.each(["", "   ", "\nprivate file contents: some-secret", " \t\r\nprivate file contents: some-secret"])("gives a generic cause for an error whose first line is empty (%j), never a later line", (message) => {
    expect(planningCause(message)).toBe("the error gave no details");
  });

  it("stays fast on a very long first line", () => {
    const started = performance.now();
    expect(planningCause(`${"token".repeat(200_000)} and ${"a-".repeat(200_000)}`)).toContain(" and ");
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
