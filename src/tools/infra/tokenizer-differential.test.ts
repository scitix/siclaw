import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCommand, extractCommands } from "./command-validator.js";
import { CONTAINER_SENSITIVE_PATHS, parseArgs } from "./command-sets.js";

/**
 * The tokenizers in `command-validator.ts` model bash's quoting rules. Every defect found in them so far
 * — three separate ones — was a case where the model disagreed with bash, and every one was found by
 * running bash, never by reading the code:
 *
 *   'x\'        a backslash inside `'…'` escapes nothing, so the next `'` always closes
 *   \'          OUTSIDE quotes a backslash escapes ANY character, quotes included
 *   'x'\''y'    which is what the ordinary idiom for an apostrophe-in-single-quotes is made of
 *
 * Enumerating payloads is what let each of these through: the list only ever contains the constructs
 * someone thought of. So these tests do not assert a verdict per payload. They run the SAME string
 * through bash and through the tokenizer and require the two to agree — bash says whether a second
 * command really ran, the tokenizer says whether it saw one. A disagreement fails, and its direction
 * names the defect: bash ran it and we allowed it is a bypass; bash did not and we refused is a false
 * refusal.
 *
 * Both facts are observed as SIDE EFFECTS (a file appearing), not as text in stdout. Matching a marker
 * string gave a false pass on `x\`, where the escaped separator turns the whole tail into an argument to
 * echo — which duly printed the marker without running anything.
 *
 * Portability: these constructs are POSIX shell quoting, identical in bash 3.2 (macOS), bash 5.2 and
 * dash — measured in all three, and this file runs whichever /bin/bash the host has.
 */

const opts = { context: "node" as const, sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS };

const dir = mkdtempSync(join(tmpdir(), "tokenizer-diff-"));
const MARK = join(dir, "second-command-ran");

/** Did bash really execute a command past the separator? Observed by side effect. */
function bashCrossedBoundary(left: string, sep: string): boolean | "unparsable" {
  rmSync(MARK, { force: true });
  try {
    execFileSync("/bin/bash", ["-c", `${left}${sep} touch ${MARK}`], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    const err = String(e.stderr ?? "");
    if (/unexpected EOF|unterminated|syntax error/.test(err)) return "unparsable";
  }
  return existsSync(MARK);
}

/**
 * Quoting constructs, each spliced in front of a separator. The list is not the test — the comparison is.
 * It exists to give the comparison enough shapes to be interesting.
 */
/**
 * The constructs are GENERATED, not listed. Listing is what let three defects through, and it let a
 * fourth through the first version of THIS file: the `$'…'` detection looked only at the character before
 * the quote, so `\$'x\'` and `$$'x\'` were read as ANSI-C strings that bash never starts — and my
 * hand-written list happened to contain neither prefix. The product of prefixes × quotes × backslash
 * counts covers the combinations nobody thinks to write down.
 */
const PREFIXES = ["", "\\", "$", "$$", "\\\\", "$$$", "\\$"];
const QUOTED = ["'x\\'", "'x\\\\'", "'x'", '"x\\"', '"x\\\\"', '"x"'];
const CONSTRUCTS = [
  ...PREFIXES.flatMap((p) => QUOTED.map((q) => `echo ${p}${q}`)),
  // outside quotes a backslash escapes anything at all, including a quote
  "echo \\'", 'echo \\"', "echo \\'\\'", "echo x\\",
  // the ordinary idiom for an apostrophe inside single quotes, made of the case above
  "echo 'x'\\''y'", "echo 'it'\\''s'",
  // separators as data
  "echo 'a;b'", 'echo "a;b"', "echo $'a;b'", "echo 'a&&b'", "echo 'a|b'",
  // mixed nesting
  "echo 'x\"y'", "echo \"x'y\"", "echo ''", 'echo ""',
];

/**
 * The assertion is ONE-WAY, and that is the point.
 *
 * "bash crossed the boundary and we did not see it" is a policy bypass — a hard failure. "bash did not
 * cross it and we refused anyway" is over-refusal: annoying, never dangerous. The first version of this
 * file asserted equality in both directions, which treats those two as equally bad and forces the
 * tokenizer to reproduce bash's lexer exactly — the pursuit that produced every hole here so far.
 *
 * With the implication one-way, the tokenizer is free to be deliberately conservative where bash's rules
 * get tangled (`$$$'…'`, `\\$'…'`), which is what `opensAnsiC` does. Over-refusal is bounded separately,
 * by the fixed list of ordinary commands at the bottom of this file — that is where a regression in
 * everyday usability would show up, and it is a much easier property to state correctly.
 */
describe("if bash runs a second command, the tokenizer must have seen it", () => {
  for (const left of CONSTRUCTS) {
    it(`${JSON.stringify(left)}`, () => {
      const crossed = bashCrossedBoundary(left, ";");
      if (crossed === "unparsable") {
        // bash cannot parse it, so nothing can run and either verdict is safe.
        expect(() => validateCommand(`${left}; rm boundary`, opts)).not.toThrow();
        return;
      }
      const refused = validateCommand(`${left}; rm boundary`, opts) !== null;
      if (crossed) {
        expect(refused, "bash ran the second command and the tokenizer did not see it — policy bypass").toBe(true);
      } else {
        // Not asserted. Refusing here is over-strict, not unsafe.
        expect(typeof refused).toBe("boolean");
      }
    });
  }
});

describe("the same one-way property across every separator", () => {
  // `||` only reaches its right side when the left one fails, hence `false` there.
  for (const [sep, lhs] of [[";", "echo"], ["&&", "echo"], ["||", "false"], ["|", "echo"]] as const) {
    it(`${sep}`, () => {
      const crossed = bashCrossedBoundary(`${lhs} 'x\\'`, ` ${sep}`);
      const refused = validateCommand(`${lhs} 'x\\' ${sep} rm boundary`, opts) !== null;
      if (crossed) expect(refused).toBe(true);
    });
  }
});

describe("a $ that does not introduce an ANSI-C string", () => {
  // The fourth defect, pinned by shape rather than through the generated sweep, because the reason each
  // one is not ANSI-C is different and worth naming.
  it("an escaped $ leaves a PLAIN single quote, which closes at the next quote", () => {
    expect(extractCommands("echo \\$'x\\'; rm boundary")).toEqual(["echo \\$'x\\'", "rm boundary"]);
    expect(validateCommand("echo \\$'x\\'; rm boundary", opts)).not.toBeNull();
  });

  it("$$ is the pid, so the quote after it is plain too", () => {
    expect(validateCommand("echo $$'x\\'; rm boundary", opts)).not.toBeNull();
  });

  it("a real $'…' still honours its escapes", () => {
    // The counter-case: if this split, the conservative rule would have gone too far.
    expect(extractCommands("echo $'x\\'; still one'")).toEqual(["echo $'x\\'; still one'"]);
  });

  it("and an ordinary $'…' argument is untouched", () => {
    expect(validateCommand("echo $'a\\nb'", opts)).toBeNull();
    expect(validateCommand("grep -c $'\\t' /etc/hostname", opts)).toBeNull();
  });
});

/**
 * The redirection ban, swept the same way: generate the forms rather than list them, and judge by whether
 * a file appears.
 *
 * `>&` reads as descriptor syntax, so the check allowed everything after it with a single `continue` — for
 * the whole history of this file. But `[n]>&word` only duplicates a descriptor when `word` is a number or
 * `-`; otherwise bash writes the file, and `echo HI >& /tmp/out` did.
 */
describe("every redirection form that writes a file is refused", () => {
  const FD_PREFIXES = ["", "0", "1", "2", "3"];
  const OPERATORS = [">", ">>", ">&", "&>", ">>&"];
  const target = join(dir, "swept");

  for (const fd of FD_PREFIXES) {
    for (const op of OPERATORS) {
      for (const gap of ["", " "]) {
        const payload = `echo HI ${fd}${op}${gap}TARGET`;
        it(JSON.stringify(payload), () => {
          const real = payload.replace("TARGET", target);
          rmSync(target, { force: true });
          try { execFileSync("/bin/bash", ["-c", real], { stdio: "ignore" }); } catch { /* ambiguous redirect etc. */ }
          const created = existsSync(target);
          const refused = validateCommand(real, opts) !== null;
          if (created) {
            expect(refused, `bash wrote the file with ${JSON.stringify(op)} — this must be refused`).toBe(true);
          }
        });
      }
    }
  }
});

describe("whitespace between a redirection and its target", () => {
  // A tab separates them exactly as a space does. The `/dev/null` exception skipped only spaces, so
  // `> \t/dev/null` was refused while the `>&` branch a few lines above skipped both — two whitespace
  // rules in one function. Swept rather than listed, and both directions are asserted here because both
  // are decidable: /dev/null must pass, a file must not.
  const GAPS = ["", " ", "\t", "\t ", " \t", "\t\t", "  "];
  const target = join(dir, "gap-target");
  for (const gap of GAPS) {
    for (const op of [">", ">>", "2>", "1>"]) {
      it(`${JSON.stringify(op + gap)} to /dev/null is permitted`, () => {
        expect(validateCommand(`echo HI ${op}${gap}/dev/null`, opts),
          "bash accepts any whitespace here, and this is an ordinary diagnostic form").toBeNull();
      });
      it(`${JSON.stringify(op + gap)} to a file is refused`, () => {
        // The whitespace widening must not have widened what counts as /dev/null.
        expect(validateCommand(`echo HI ${op}${gap}${target}`, opts)).not.toBeNull();
      });
    }
  }

  // The exception must name /dev/null and nothing else. It was written with `\b`, which only requires the
  // NEXT character not to be a word character — so every path below was read as the discard target, and
  // each one wrote a real file when bash ran it. Found by asserting this while fixing the whitespace
  // above; the two live on adjacent lines.
  for (const suffix of [".bak", "-x", "~", ",x", ":x", "+x", "x", "2", "/../../tmp/pwn"]) {
    it(`/dev/null${suffix} is not /dev/null`, () => {
      expect(validateCommand(`echo HI > /dev/null${suffix}`, opts),
        `\`/dev/null${suffix}\` is a different file — bash writes it`).not.toBeNull();
    });
  }

  // …while the real thing keeps working in every position it legitimately appears.
  for (const cmd of [
    "echo HI > /dev/null", "echo HI >/dev/null", "echo HI >\t/dev/null",
    "ls /nope 2>/dev/null", "ls /nope 2> /dev/null",
    "echo HI > /dev/null; echo done", "echo HI > /dev/null && echo done",
    "echo HI > /dev/null | cat", "ls /nope 2>/dev/null | grep -c x",
  ]) {
    it(`still permitted: ${JSON.stringify(cmd)}`, () => {
      expect(validateCommand(cmd, opts)).toBeNull();
    });
  }
});

describe("but real descriptor duplication still works", () => {
  // The over-refusal bound for the rule above. These are ordinary in diagnostics — merging stderr into
  // stdout is how most commands here are run — so a fix that refused them would be a worse regression
  // than the hole it closed.
  for (const cmd of [
    "echo HI >&2", "echo HI 2>&1", "echo HI 1>&2", "ls /nope 2>&1",
    "echo HI >& 2", "echo HI 2>& 1", "echo HI 2>&-", "echo HI 3>&-",
    "kubectl get pods 2>&1", "ps -ef 2>&1 | grep -c kubelet",
    "cat /etc/hostname > /dev/null", "ls /nope 2>/dev/null",
  ]) {
    it(cmd, () => {
      expect(validateCommand(cmd, { ...opts, extraAllowed: new Set(["kubectl"]) })).toBeNull();
    });
  }
});

describe("a redirection cannot hide behind a quote bash never opened", () => {
  // The check the escape defect broke most cleanly, and the one with an unarguable witness: either the
  // file exists afterwards or it does not. Every payload here was permitted before the fix, while bash
  // created the file.
  const target = join(dir, "redirect-landed");
  for (const payload of [
    "echo \\' > TARGET",
    'echo \\" > TARGET',
    "echo 'x'\\''y' > TARGET",
    "echo 'x\\' > TARGET",
    "echo \\'\\' > TARGET",
    "echo plain > TARGET",
  ]) {
    it(payload, () => {
      const real = payload.replaceAll("TARGET", target);
      rmSync(target, { force: true });
      try { execFileSync("/bin/bash", ["-c", real], { stdio: "ignore" }); } catch { /* exit code is not the question */ }
      const created = existsSync(target);
      const refused = validateCommand(real, opts) !== null;
      if (created) {
        expect(refused, "bash created the file, so the redirection ban must have refused this").toBe(true);
      }
    });
  }
});

describe("what the tokenizer produces, for the record", () => {
  // Spot checks of the actual split, so a future reader can see the shapes rather than infer them from
  // verdicts. These are the three defects, in order.
  it("a backslash inside '…' does not extend the string", () => {
    expect(extractCommands("echo 'x\\'; rm boundary")).toEqual(["echo 'x\\'", "rm boundary"]);
  });

  it("an escaped quote outside a string does not open one", () => {
    expect(extractCommands("echo \\'; rm boundary")).toEqual(["echo \\'", "rm boundary"]);
  });

  it("adjacent-quote concatenation ends where bash ends it", () => {
    expect(extractCommands("echo 'x'\\''y'; rm boundary")).toEqual(["echo 'x'\\''y'", "rm boundary"]);
  });

  it("an escaped separator is still data, and still one command", () => {
    // The counter-case. Widening the escape rule must not break `find -exec … \;`.
    expect(extractCommands("find . -name x -exec ls {} \\;")).toEqual(["find . -name x -exec ls {} \\;"]);
    expect(validateCommand("echo x\\; rm boundary", opts)).toBeNull();
  });

  it("a separator inside a quote is data", () => {
    expect(extractCommands("echo 'a;b'")).toEqual(["echo 'a;b'"]);
    expect(extractCommands('echo "a;b"')).toEqual(['echo "a;b"']);
  });
});

describe("ANSI-C escapes that rewrite a path", () => {
  // `$'…'` decodes escapes, so the argv the process receives is not the text that was screened. Octal and
  // hex were decoded here; `\u`/`\U` were not, and bash 4.2+ decodes those too — measured in bash 5.2,
  // where `cat $'\u002fetc\u002fhostname'` reads the real file. The gap mattered because `cut`,
  // `hexdump` and `od` are whitelisted and have no content redactor, so the path was readable.
  const SPELLINGS = [
    "$'\\x2fetc\\x2fshadow'",              // hex — was already covered
    "$'\\057etc\\057shadow'",              // octal — was already covered
    "$'\\u002fetc\\u002fshadow'",          // \u — was NOT
    "$'\\U0000002fetc\\U0000002fshadow'",  // \U — was NOT
    "$'\\u002fetc/shadow'",                  // mixed
    "/etc/shadow",                             // the plain form, as the control
  ];
  for (const spelling of SPELLINGS) {
    for (const bin of ["cut -c1", "hexdump", "od", "cat"]) {
      it(`${bin} ${spelling}`, () => {
        expect(validateCommand(`${bin} ${spelling}`, opts), `${bin} ${spelling}`).not.toBeNull();
      });
    }
  }

  it("decodes to the same argv the shell would pass", () => {
    for (const spelling of SPELLINGS.slice(0, 4)) {
      expect(parseArgs(`cat ${spelling}`).at(-1), spelling).toBe("/etc/shadow");
    }
  });

  it("and an escape that names nothing sensitive still runs", () => {
    expect(validateCommand("echo $'\\u0041\\u0042'", opts)).toBeNull();
    expect(validateCommand("grep -c $'\\t' /etc/hostname", opts)).toBeNull();
    // A code point past the Unicode range is left as written, which is what bash does.
    expect(validateCommand("echo $'\\U0011FFFFx'", opts)).toBeNull();
  });
});
