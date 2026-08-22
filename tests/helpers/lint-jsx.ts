// Static linter for our JSX files. ExtendScript (ES3) has no support for
// modern JS syntax or newer Array/String methods. This module scans jsx/ for
// the most common mistakes BEFORE they hit AE (where bugs are expensive to
// find because of the `-r` round-trip cost and AE state issues).
//
// This is a deliberately conservative regex-based check. False positives are
// possible when the forbidden token appears inside a string literal or
// comment — we strip line comments and JS string literals before scanning to
// keep the signal clean.

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

export interface LintRule {
  id: string;
  description: string;
  /** Test a post-stripped line, return true if it's a violation. */
  regex: RegExp;
  severity: "error" | "warn";
}

const rules: LintRule[] = [
  // ES5/ES6 syntax forbidden in ExtendScript (ES3)
  {
    id: "es6-let",
    description: "`let` is not supported in ExtendScript. Use `var`.",
    regex: /\blet\s+[\w$]/,
    severity: "error",
  },
  {
    id: "es6-const",
    description: "`const` is not supported in ExtendScript. Use `var`.",
    regex: /\bconst\s+[\w$]/,
    severity: "error",
  },
  {
    id: "es6-arrow",
    description: "Arrow functions are not supported in ExtendScript. Use function().",
    regex: /=>\s*[{(\w"']/,
    severity: "error",
  },
  {
    id: "es6-template-string",
    description: "Template literals are not supported. Use string concatenation.",
    regex: /`[^`]*\$\{/,
    severity: "error",
  },
  {
    id: "es6-for-of",
    description: "for...of is not supported. Use a C-style for loop.",
    regex: /\bfor\s*\([^;)]*\bof\s+/,
    severity: "error",
  },
  {
    id: "es6-destructure-obj",
    description: "Object destructuring is not supported.",
    regex: /\b(?:var|let|const)\s*\{[\s\S]*?\}\s*=/,
    severity: "error",
  },
  {
    id: "es6-destructure-arr",
    description: "Array destructuring is not supported.",
    regex: /\b(?:var|let|const)\s*\[[^\]]*\]\s*=/,
    severity: "error",
  },
  {
    id: "es6-spread",
    description: "Spread/rest syntax (...) is not supported.",
    regex: /\.{3}[\w$]/,
    severity: "error",
  },
  // Array methods not in ES3
  {
    id: "es5-array-map",
    description: "Array.prototype.map not in ES3. Use a for loop.",
    regex: /\.\s*map\s*\(/,
    severity: "error",
  },
  {
    id: "es5-array-filter",
    description: "Array.prototype.filter not in ES3. Use a for loop.",
    regex: /\.\s*filter\s*\(/,
    severity: "error",
  },
  {
    id: "es5-array-forEach",
    description: "Array.prototype.forEach not in ES3. Use a for loop.",
    regex: /\.\s*forEach\s*\(/,
    severity: "error",
  },
  {
    id: "es5-array-some",
    description: "Array.prototype.some not in ES3.",
    regex: /\.\s*some\s*\(/,
    severity: "warn",
  },
  {
    id: "es5-array-every",
    description: "Array.prototype.every not in ES3.",
    regex: /\.\s*every\s*\(/,
    severity: "warn",
  },
  {
    id: "es5-array-find",
    description: "Array.prototype.find not in ES3.",
    regex: /\.\s*find\s*\(/,
    severity: "warn",
  },
  // String methods not in ES3
  {
    id: "es6-str-includes",
    description: "String.prototype.includes not in ES3. Use indexOf !== -1.",
    regex: /\.\s*includes\s*\(/,
    severity: "error",
  },
  {
    id: "es6-str-startsWith",
    description: "String.prototype.startsWith not in ES3. Use indexOf === 0.",
    regex: /\.\s*startsWith\s*\(/,
    severity: "error",
  },
  {
    id: "es6-str-endsWith",
    description: "String.prototype.endsWith not in ES3.",
    regex: /\.\s*endsWith\s*\(/,
    severity: "error",
  },
  {
    id: "es6-str-repeat",
    description: "String.prototype.repeat not in ES3.",
    regex: /\.\s*repeat\s*\(/,
    severity: "warn",
  },
  // Object methods
  {
    id: "es5-object-keys",
    description:
      "Object.keys not available in ExtendScript ES3 runtime. Use for (k in obj) with hasOwnProperty.",
    regex: /\bObject\.keys\s*\(/,
    severity: "warn",
  },
  {
    id: "es5-object-values",
    description: "Object.values not available.",
    regex: /\bObject\.values\s*\(/,
    severity: "error",
  },
  {
    id: "es5-object-assign",
    description: "Object.assign not available.",
    regex: /\bObject\.assign\s*\(/,
    severity: "error",
  },
  // ES3 reserved future words used as identifiers
  {
    id: "es3-reserved-native",
    description: "`native` is a reserved word in ES3. Use a different variable name.",
    regex: /\bvar\s+native\b/,
    severity: "error",
  },
  {
    id: "es3-reserved-abstract",
    description: "`abstract` is a reserved word in ES3.",
    regex: /\bvar\s+abstract\b/,
    severity: "error",
  },
  {
    id: "es3-reserved-int",
    description: "`int` is a reserved word in ES3.",
    regex: /\bvar\s+int\b/,
    severity: "error",
  },
  {
    id: "es3-reserved-long",
    description: "`long` is a reserved word in ES3.",
    regex: /\bvar\s+long\b/,
    severity: "error",
  },
  {
    id: "es3-reserved-short",
    description: "`short` is a reserved word in ES3.",
    regex: /\bvar\s+short\b/,
    severity: "error",
  },
  {
    id: "es3-reserved-boolean",
    description: "`boolean` is a reserved word in ES3.",
    regex: /\bvar\s+boolean\b/,
    severity: "error",
  },
  {
    id: "es3-reserved-byte",
    description: "`byte` is a reserved word in ES3.",
    regex: /\bvar\s+byte\b/,
    severity: "error",
  },
  {
    id: "es3-reserved-char",
    description: "`char` is a reserved word in ES3.",
    regex: /\bvar\s+char\b/,
    severity: "error",
  },
  {
    id: "es3-reserved-double",
    description: "`double` is a reserved word in ES3.",
    regex: /\bvar\s+double\b/,
    severity: "error",
  },
  {
    id: "es3-reserved-float",
    description: "`float` is a reserved word in ES3.",
    regex: /\bvar\s+float\b/,
    severity: "error",
  },
  {
    id: "es3-reserved-import",
    description: "`import` is a reserved word in ES3.",
    regex: /\bvar\s+import\b/,
    severity: "error",
  },
  {
    id: "es3-reserved-export",
    description: "`export` is a reserved word in ES3.",
    regex: /\bvar\s+export\b/,
    severity: "error",
  },
  // ExtendScript runtime hazards that look like ordinary JavaScript
  {
    // `"failed: " + e` is not shorthand, it is a second bug on top of the
    // first: ExtendScript cannot coerce an Error to a primitive, so the
    // concatenation throws ("Object of type Error found where a Number, Array,
    // or Property is needed") from inside the handler that was reporting the
    // original failure. The real error is lost and the replacement escapes —
    // in the dispatcher, as far as AE's modal error dialog, which then blocks
    // scripting for the rest of the session.
    //
    // Matches only the catch-parameter names this codebase uses (`e`, `eRm`,
    // `eCtx`, `err`), so an ordinary variable is never mistaken for one. It
    // does not — cannot — see a value laundered through a local first.
    id: "es-error-concat",
    description:
      "Concatenating a caught exception throws in ExtendScript. Use AE.errText(e) (dispatcher.jsx has its own describeError).",
    regex: /\+\s*(?:e|e[A-Z][\w$]*|err)(?![\w$(.])/,
    severity: "error",
  },
  // AE-specific bugs
  {
    id: "ae-no-items-addsolid",
    description:
      "app.project.items.addSolid does NOT exist. Use comp.layers.addSolid then harvest layer.source.",
    regex: /items\s*\.\s*addSolid\s*\(/,
    severity: "error",
  },
  // Modern JS runtime globals not in ExtendScript
  {
    id: "no-promise",
    description: "Promise is not available in ExtendScript.",
    regex: /\bnew\s+Promise\s*\(/,
    severity: "error",
  },
  {
    id: "no-settimeout",
    description: "setTimeout is not available. Use app.scheduleTask.",
    regex: /\bsetTimeout\s*\(/,
    severity: "error",
  },
  {
    id: "no-console-log",
    description: "console.log is not available. Use $.writeln or the dispatcher's log() helper.",
    regex: /\bconsole\s*\.\s*log\s*\(/,
    severity: "error",
  },
];

/**
 * Detect CHAINED ternaries — `a ? b : c ? d : e` without parentheses around
 * the nested conditional. ExtendScript parses the conditional operator
 * LEFT-associatively (verified on AE 26.3 / ExtendScript 4.5.6): that chain
 * runs as `(a ? b : c) ? d : e`, so every branch except the final else
 * collapses into whichever operand the LAST condition selects. This shipped a
 * real bug — ae_context labelled every project item "Folder". `a ? b : (c ?
 * d : e)` and if/else are both fine.
 *
 * `text` must already have comments and string literals stripped. Returns
 * 0-based indices into `text` where the offending `?` sits. The scan tracks
 * bracket depth; a second `?` at the same depth while a ternary at that depth
 * is open or completed (not yet reset by `,` `;` or an object-key `:`) is a
 * chain. Regex literals are not stripped — a lone `?` inside one cannot
 * complete the `? … : … ?` sequence at one depth, so they do not false-positive.
 */
export function findTernaryChains(text: string): number[] {
  interface DepthState {
    open: number;
    completed: boolean;
  }
  const hits: number[] = [];
  const stack: DepthState[] = [{ open: 0, completed: false }];
  const top = (): DepthState => stack[stack.length - 1];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      stack.push({ open: 0, completed: false });
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const s = top();
    if (ch === "?") {
      if (s.open > 0 || s.completed) hits.push(i);
      else s.open = 1;
      continue;
    }
    if (ch === ":") {
      if (s.open > 0) {
        s.open--;
        s.completed = true;
      } else {
        // Object-key colon: a fresh value context begins.
        s.completed = false;
      }
      continue;
    }
    if (ch === "," || ch === ";") {
      s.open = 0;
      s.completed = false;
    }
  }
  return hits;
}

export const TERNARY_CHAIN_RULE = {
  id: "es3-ternary-chain",
  description:
    "Chained ternary (`a ? b : c ? d : e`) — ExtendScript parses ?: LEFT-associatively, " +
    "so this evaluates as `(a ? b : c) ? d : e` and picks the wrong branch. " +
    "Parenthesize the nested conditional or use if/else.",
  severity: "error" as const,
};

function stripCommentsAndStrings(line: string): string {
  // Strip JS // comments first
  const commentIdx = findFirstCommentStart(line);
  let code = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
  // Strip string literals (naive but good enough for single-line content)
  code = code.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  code = code.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  // Template literal detection uses the raw line separately, so string
  // stripping here cannot hide it from other rules.
  return code;
}

export function findFirstCommentStart(line: string): number {
  // Find first `//` that is not inside a string literal.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (!inDouble && ch === "'") inSingle = !inSingle;
    else if (!inSingle && ch === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === "/" && line[i + 1] === "/") return i;
  }
  return -1;
}

export interface LintFinding {
  file: string;
  line: number;
  rule: string;
  severity: "error" | "warn";
  description: string;
  text: string;
}

export function lintJsxFile(filePath: string): LintFinding[] {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const findings: LintFinding[] = [];
  // Strip /* */ block comments across the whole file before line-scanning
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const strippedLines = stripped.split(/\r?\n/);
  const cleanLines: string[] = [];
  for (let i = 0; i < strippedLines.length; i++) {
    const originalLine = lines[i] ?? "";
    const cleanLine = stripCommentsAndStrings(strippedLines[i] ?? "");
    cleanLines.push(cleanLine);
    // Special case: template literal check wants the RAW line (strings are stripped)
    for (const r of rules) {
      const target = r.id === "es6-template-string" ? originalLine : cleanLine;
      if (r.regex.test(target)) {
        findings.push({
          file: filePath,
          line: i + 1,
          rule: r.id,
          severity: r.severity,
          description: r.description,
          text: originalLine.trim(),
        });
      }
    }
  }
  // Ternary chains span lines, so this rule scans the whole cleaned text.
  const cleanText = cleanLines.join("\n");
  for (const offset of findTernaryChains(cleanText)) {
    const line = cleanText.slice(0, offset).split("\n").length;
    findings.push({
      file: filePath,
      line,
      rule: TERNARY_CHAIN_RULE.id,
      severity: TERNARY_CHAIN_RULE.severity,
      description: TERNARY_CHAIN_RULE.description,
      text: (lines[line - 1] ?? "").trim(),
    });
  }
  return findings;
}

/** Lint every .jsx/.js file directly under `dir`. Returns all findings. */
export function lintJsxDir(dir: string): LintFinding[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const e of entries) {
    if (e.endsWith(".jsx") || e.endsWith(".js")) files.push(path.join(dir, e));
  }
  const all: LintFinding[] = [];
  for (const f of files) {
    all.push(...lintJsxFile(f));
  }
  return all;
}
