// Lint for generated ExtendScript. Two rules, both about things that are
// invisible in the TypeScript but fatal once the string reaches AE:
//
//   1. injection — a tool argument interpolated raw (the security invariant
//      below),
//   2. exception-to-text — a caught exception rendered with `+` or String(),
//      which throws inside the very handler meant to report the failure.
//
// The security invariant: a value that came from tool arguments must never be
// interpolated raw into generated JSX. Raw interpolation is an injection
// vector — a comp name of `"; <arbitrary ES3>; var x = "` would otherwise
// become executable code inside After Effects, bypassing the capability
// policy entirely (which only gates WHICH operation runs, never what its
// arguments expand to). Everything user-supplied goes through `jsxVal` or one
// of the lookup preambles, which JSON-encode it into a literal.
//
// CONTRIBUTING documented this rule; nothing enforced it. This module does.
//
// Scope and limits, stated plainly because this is a security control:
//   - It flags a bare `args` reference inside a template literal that looks
//     like generated JSX. That is the direct form the rule is about.
//   - It does NOT track a value laundered through a local variable
//     (`const n = args.name` … `${n}`). Catching that needs real dataflow
//     analysis. Code review still owns that case, and `jsxVal` at the point of
//     embedding remains the standing rule.
//   - Interpolating OTHER generated code (`${jsx}`, `${COMP_INFO_FN}`) is
//     allowed and not flagged: that code was itself produced under this rule.

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

/**
 * Callees that turn a value into a safe JSX literal: the `jsx*` helper family
 * (`jsxVal`, the `jsx*Preamble` lookups, `jsxPropertyLookup`). A reference is
 * safe when ANY enclosing call is one of these, so wrappers and operators
 * inside the call (`jsxVal(!!args.flag)`, `jsxVal(String(args.comp))`) stay
 * fine while a bare `String(args.name)` — which yields raw text — does not.
 *
 * Trusting the family by name is only sound because every such helper is
 * itself defined in a file this lint scans, so its own interpolations are
 * checked. Keep it that way: a `jsx*` helper defined outside src/ would be an
 * unchecked hole.
 */
const ENCODER_NAME = /^jsx[\w$]*$/;

/**
 * True when `index` sits inside the parentheses of an encoder call. Walks
 * outward through enclosing calls: at each unmatched `(` to the left, read the
 * identifier in front of it and check it against the encoder family.
 */
function insideEncoderCall(body: string, index: number): boolean {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const ch = body[i];
    if (ch === ")") {
      depth++;
      continue;
    }
    if (ch !== "(") continue;
    if (depth > 0) {
      depth--;
      continue;
    }
    // Unmatched `(` — the call we are directly inside. Read its callee.
    const callee = /([\w$]+)\s*$/.exec(body.slice(0, i));
    if (callee !== null && ENCODER_NAME.test(callee[1])) return true;
    // Not an encoder: keep walking outward in case a wrapper is.
  }
  return false;
}

/**
 * True when `index` is in the TEST position of a ternary that decides whether
 * to emit a fragment at all — `${args.name ? \`…\` : ""}`. The value never
 * reaches the output there; only the branch does, and the branch embeds
 * through an encoder (which this lint checks separately). Detected as: the
 * innermost enclosing `${…}` has a `?` at its own nesting depth, and the
 * reference sits before it.
 */
function inTernaryTest(body: string, index: number): boolean {
  // Find the innermost enclosing `${`, balancing `}` on the way back.
  let closes = 0;
  let open = -1;
  for (let i = index - 1; i >= 1; i--) {
    if (body[i] === "}") {
      closes++;
      continue;
    }
    if (body[i] === "{" && body[i - 1] === "$") {
      if (closes === 0) {
        open = i + 1;
        break;
      }
      closes--;
    }
  }
  if (open === -1) return false;

  // Walk forward to the interpolation's own `?`, ignoring nested spans.
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "}") {
      if (depth === 0) return false; // interpolation ended before any `?`
      depth--;
    } else if (ch === "`") {
      // Skip a nested template literal wholesale.
      let j = i + 1;
      let inner = 0;
      while (j < body.length) {
        if (body[j] === "\\") j += 2;
        else if (body[j] === "$" && body[j + 1] === "{") {
          inner++;
          j += 2;
        } else if (inner > 0 && body[j] === "}") {
          inner--;
          j++;
        } else if (inner === 0 && body[j] === "`") break;
        else j++;
      }
      i = j;
    } else if (ch === "?" && depth === 0 && body[i + 1] !== ".") {
      return index < i;
    }
  }
  return false;
}

export interface CodegenFinding {
  file: string;
  line: number;
  text: string;
  message: string;
}

/**
 * A template literal is treated as generated JSX when it carries a marker of
 * ExtendScript we emit. Deliberately broad: over-classifying only costs a
 * false positive on a TS string that mentions `args`, which review can fix by
 * hoisting the value out of the literal.
 */
function looksLikeJsx(body: string): boolean {
  return (
    /\breturn\b/.test(body) ||
    /\bAE\s*\./.test(body) ||
    /\bapp\s*\./.test(body) ||
    /\bvar\s+_/.test(body)
  );
}

/** Spans of every template literal in `src`, as [start, end) over the raw text. */
function templateLiteralSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // Skip over line comments, block comments, and quoted strings so a
    // backtick inside them cannot open a phantom template literal.
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "`") {
      const start = i;
      i++;
      let depth = 0;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          depth++;
          i += 2;
          continue;
        }
        if (depth > 0 && src[i] === "}") {
          depth--;
          i++;
          continue;
        }
        if (depth === 0 && src[i] === "`") break;
        i++;
      }
      spans.push([start, Math.min(i + 1, src.length)]);
      i++;
      continue;
    }
    i++;
  }
  return spans;
}

/**
 * Catch-parameter names as this codebase writes them — `e`, `eRm`, `eCtx`,
 * `err`. Kept deliberately narrow: an ordinary identifier that merely starts
 * with `e` (`expr`, `entry`, `easing`) must not be mistaken for an exception.
 */
const ERROR_IDENT = "(?:e|e[A-Z][\\w$]*|err)";

/**
 * Rendering a caught exception into text by coercion. ExtendScript cannot
 * convert an Error to a primitive, so `"failed: " + e` and `String(e)` throw
 * where they stand — inside the handler that exists to report the original
 * failure, which is then lost and replaced by a bogus one. `AE.errText(e)`
 * reads `.message` instead and never throws.
 */
const ERROR_TO_TEXT: RegExp[] = [
  new RegExp(`\\+\\s*${ERROR_IDENT}(?![\\w$(.])`, "g"),
  new RegExp(`\\bString\\(\\s*${ERROR_IDENT}\\s*\\)`, "g"),
];

export function lintCodegenFile(filePath: string): CodegenFinding[] {
  const src = readFileSync(filePath, "utf8");
  const lines = src.split(/\r?\n/);
  const findings: CodegenFinding[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  for (const [start, end] of templateLiteralSpans(src)) {
    const body = src.slice(start, end);
    if (!looksLikeJsx(body)) continue;
    const argsRef = /\bargs\b/g;
    let m: RegExpExecArray | null;
    while ((m = argsRef.exec(body)) !== null) {
      if (insideEncoderCall(body, m.index)) continue;
      if (inTernaryTest(body, m.index)) continue;
      const absolute = start + m.index;
      const line = lineOf(absolute);
      findings.push({
        file: filePath,
        line,
        text: (lines[line - 1] ?? "").trim(),
        message:
          "raw `args` reference inside generated JSX — embed it with jsxVal(...) " +
          "(or a lookup preamble). Interpolating a tool argument straight into " +
          "ExtendScript is an injection vector. If this is a condition rather " +
          "than an embedded value, hoist it into a const above the template.",
      });
    }

    for (const rule of ERROR_TO_TEXT) {
      rule.lastIndex = 0;
      while ((m = rule.exec(body)) !== null) {
        const line = lineOf(start + m.index);
        findings.push({
          file: filePath,
          line,
          text: (lines[line - 1] ?? "").trim(),
          message:
            `\`${m[0].trim()}\` renders a caught exception by coercion. ExtendScript ` +
            "cannot coerce an Error to a primitive, so this throws inside the handler " +
            "and the original failure is lost. Use AE.errText(...) instead.",
        });
      }
    }
  }
  return findings;
}

/** Lint every .ts file under `dir`, recursively. */
export function lintCodegenDir(dir: string): CodegenFinding[] {
  const findings: CodegenFinding[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      findings.push(...lintCodegenDir(full));
      continue;
    }
    if (entry.endsWith(".ts")) findings.push(...lintCodegenFile(full));
  }
  return findings;
}
