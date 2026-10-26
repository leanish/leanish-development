import { realpathSync } from "node:fs";
import { homedir } from "node:os";

import { escape } from "./manifest-spec.ts";
import { defused } from "./plan-blocks.ts";
import type { PullRequestContent } from "./publication.ts";

/** Where a published text's local paths come from: the working copy, and the rest of the machine. */
export interface LocalRoots {
  /** The working copy (and its canonical path when different): paths inside it become repository-relative. */
  readonly workingCopy: ReadonlyArray<string>;
  /** Other absolute directories whose paths never reach a PR: the home directory, the temp dirs, the tool's state and cache. */
  readonly other: ReadonlyArray<string>;
}

export const LOCAL_PATH = "<local path>";

/** The roots outside the working copy for a tool with these state and cache directories, with their canonical paths. */
export function machineRoots(
  dirs: { readonly state: string; readonly cache: string },
  home: string = homedir(),
  canonical: (path: string) => string = realpathSync,
): ReadonlyArray<string> {
  return withCanonical([dirs.state, dirs.cache, "/private/var/folders", "/var/folders", "/private/tmp", "/tmp", home], canonical);
}

/** The paths, each also as its canonical path when it exists and differs: commands report the physical one. */
export function withCanonical(paths: ReadonlyArray<string>, canonical: (path: string) => string = realpathSync): ReadonlyArray<string> {
  const all = new Set(paths);
  for (const path of paths) {
    try {
      all.add(canonical(path));
    } catch {
      // A directory that doesn't exist yet has no other name to show up under.
    }
  }
  return [...all];
}

/**
 * Keeps the local machine out of a PR's title, description and commit message. An absolute path inside the working copy
 * becomes repository-relative (the root itself `.`); one under another local root becomes `<local path>`, whether bare,
 * quoted, in backticks, in a Markdown link, after `NAME=`, as `file://` or with a `:line:column` suffix. Only a path that
 * starts a token counts, so a URL's or a relative path's own `/tmp/...` stays as it is. The body also
 * loses the lines Node prints when the sandbox hides the system's certificate trust settings. The tool's own markers
 * (`<!-- leanish:… -->`: its state and encoded plan) pass through untouched; any other HTML comment, a code example's
 * included, is cleaned like the rest: this cleans what readers see, not every byte.
 */
export function cleanContent(content: PullRequestContent, roots: LocalRoots): PullRequestContent {
  return {
    title: cleanText(content.title, roots),
    body: cleanBody(content.body, roots),
    commitMessage: cleanText(content.commitMessage, roots),
  };
}

/**
 * A body's text cleaned the same way, outside its HTML comments. Cleaning can turn a path into a plan marker
 * (`<!-- /working/copy/leanish:plan … -->` loses its root), so what it leaves is defused: the only blocks are the
 * ones the tool's own sections carry.
 */
export function cleanBody(body: string, roots: LocalRoots): string {
  return outsideComments(body, (text) => defused(withoutNoise(cleanText(text, roots))));
}

/** Web links stay whole, a path in their query included: they point elsewhere, not at this machine. */
function cleanText(text: string, roots: LocalRoots): string {
  return text
    .split(/(https?:\/\/[^\s"'`)\]>]+)/)
    .map((part, i) => (i % 2 === 1 ? part : cleanPaths(part, roots)))
    .join("");
}

function cleanPaths(text: string, roots: LocalRoots): string {
  const all = [
    ...roots.workingCopy.map((root) => ({ root, relative: true })),
    ...roots.other.map((root) => ({ root, relative: false })),
  ]
    .filter(({ root }) => root.startsWith("/") && root.length > 1)
    .map(({ root, relative }) => ({ root: withoutTrailingSlashes(root), relative }))
    // The most specific root first: the working copy usually sits under the home directory.
    .sort((a, b) => b.root.length - a.root.length || Number(b.relative) - Number(a.relative));
  let cleaned = text;
  for (const { root, relative } of all) {
    const at = escape(root);
    // In double or single quotes the path runs to the closing quote, spaces included, but never past a backtick: a quote
    // in one code span must not pair with one in the next and swallow the fences between them. Backticks hold commands
    // as often as file names, so there a path ends where a bare one does.
    cleaned = cleaned.replace(new RegExp(`(["'])(?:file://)?${at}(?=[/"'])([^"'\`\\n]*)(?=\\1)`, "g"), (_, quote: string, rest: string) => `${quote}${replacement(rest, relative)}`);
    // Bare: from the start of a token to whitespace or punctuation that can't be part of it.
    cleaned = cleaned.replace(new RegExp(`${TOKEN_START}(?:file://)?${at}(?=$|[/\\s"'\`)\\]>,;:])([^\\s"'\`)\\]>,;]*)`, "g"), (_, rest: string) => replacement(rest, relative));
  }
  return cleaned;
}

/** `path` without the slashes it ends with: a loop, as `/\/+$/` takes quadratic time on many slashes not at the end. */
function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end--;
  return path.slice(0, end);
}

/** What may come right before a path: nothing, whitespace, a quote, a bracket or `=` (as in `NAME=/path`). */
const TOKEN_START = "(?<=^|[\\s\"'`(\\[<=,])";

function replacement(rest: string, relative: boolean): string {
  if (!relative) return LOCAL_PATH;
  const inside = rest.replace(/^\/+/, "");
  return inside === "" ? "." : inside;
}

/** Node prints this, once per system certificate, when the sandbox hides the trust settings: it says nothing about the change. */
const TRUST_SETTINGS_NOISE = /^[ \t]*(?:ERROR: )?failed to copy trust settings of system certificate(?:-\d+)?[ \t]*$/;

function withoutNoise(text: string): string {
  return text
    .split("\n")
    .filter((line) => !TRUST_SETTINGS_NOISE.test(line))
    .join("\n");
}

const OWN_COMMENT = "<!-- leanish:";
const COMMENT_END = "-->";

/**
 * `body` with `clean` applied outside the tool's own comments (`<!-- leanish:` to the first `-->` after it). One scan
 * with indexOf, not a lazy regex, which takes quadratic time on many unclosed `<!-- leanish:`. When one has no end, no
 * later one can, so the rest is all text.
 */
function outsideComments(body: string, clean: (text: string) => string): string {
  let cleaned = "";
  let at = 0;
  for (;;) {
    const start = body.indexOf(OWN_COMMENT, at);
    const end = start === -1 ? -1 : body.indexOf(COMMENT_END, start + OWN_COMMENT.length);
    if (end === -1) break;
    cleaned += clean(body.slice(at, start)) + body.slice(start, end + COMMENT_END.length);
    at = end + COMMENT_END.length;
  }
  return cleaned + clean(body.slice(at));
}
