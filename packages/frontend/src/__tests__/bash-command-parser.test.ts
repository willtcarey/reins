import { describe, test, expect } from "bun:test";
import { parseCommandSegments, type CommandSegment } from "../tool-renderers/bash-command-parser.js";

/** Helper: format segments into a readable string for snapshot-style assertions. */
function fmt(segments: CommandSegment[]): string {
  return segments
    .map((s) => {
      if (s.type === "command") return `[CMD:${s.text}]`;
      if (s.type === "operator") return `[OP:${s.text}]`;
      return s.text;
    })
    .join("");
}

/** Helper: extract just the command-type segments. */
function commands(segments: CommandSegment[]): string[] {
  return segments.filter((s) => s.type === "command").map((s) => s.text);
}

/** Helper: extract just the operator-type segments. */
function operators(segments: CommandSegment[]): string[] {
  return segments.filter((s) => s.type === "operator").map((s) => s.text);
}

describe("parseCommandSegments", () => {
  describe("simple commands", () => {
    test("bare command", () => {
      expect(fmt(parseCommandSegments("ls"))).toBe("[CMD:ls]");
    });

    test("command with flags and path", () => {
      const segs = parseCommandSegments('grep -rn "pattern" --include="*.ts" src/');
      expect(commands(segs)).toEqual(["grep"]);
      expect(operators(segs)).toEqual([]);
      expect(fmt(segs)).toBe('[CMD:grep] -rn "pattern" --include="*.ts" src/');
    });
  });

  describe("pipes", () => {
    test("simple pipe", () => {
      const segs = parseCommandSegments("grep -rn foo src/ | head -20");
      expect(commands(segs)).toEqual(["grep", "head"]);
      expect(operators(segs)).toEqual(["|"]);
      expect(fmt(segs)).toBe("[CMD:grep] -rn foo src/ [OP:|] [CMD:head] -20");
    });

    test("multi-stage pipeline", () => {
      const segs = parseCommandSegments("cat file.txt | grep error | sort | uniq -c");
      expect(commands(segs)).toEqual(["cat", "grep", "sort", "uniq"]);
      expect(operators(segs)).toEqual(["|", "|", "|"]);
    });
  });

  describe("chaining operators", () => {
    test("&& chains", () => {
      const segs = parseCommandSegments('cd /tmp && find . -name "*.log" | xargs rm');
      expect(commands(segs)).toEqual(["cd", "find", "xargs"]);
      expect(operators(segs)).toEqual(["&&", "|"]);
      expect(fmt(segs)).toBe('[CMD:cd] /tmp [OP:&&] [CMD:find] . -name "*.log" [OP:|] [CMD:xargs] rm');
    });

    test("|| fallback", () => {
      const segs = parseCommandSegments("cat file.txt || echo fallback");
      expect(commands(segs)).toEqual(["cat", "echo"]);
      expect(operators(segs)).toEqual(["||"]);
      expect(fmt(segs)).toBe("[CMD:cat] file.txt [OP:||] [CMD:echo] fallback");
    });

    test("semicolons", () => {
      const segs = parseCommandSegments("echo hello; echo world");
      expect(commands(segs)).toEqual(["echo", "echo"]);
      expect(operators(segs)).toEqual([";"]);
      expect(fmt(segs)).toBe("[CMD:echo] hello[OP:;] [CMD:echo] world");
    });
  });

  describe("env var prefixes", () => {
    test("env vars before command", () => {
      const segs = parseCommandSegments("FOO=bar NODE_ENV=test bun test");
      expect(commands(segs)).toEqual(["bun"]);
      expect(fmt(segs)).toBe("FOO=bar NODE_ENV=test [CMD:bun] test");
    });
  });

  describe("prefix words (sudo, env, etc.)", () => {
    test("sudo prefix", () => {
      const segs = parseCommandSegments("sudo docker compose up -d");
      expect(commands(segs)).toEqual(["docker"]);
      expect(fmt(segs)).toBe("sudo [CMD:docker] compose up -d");
    });

    test("env prefix", () => {
      const segs = parseCommandSegments("env node script.js");
      expect(commands(segs)).toEqual(["node"]);
    });

    test("stacked prefixes", () => {
      const segs = parseCommandSegments("sudo env nohup node server.js");
      expect(commands(segs)).toEqual(["node"]);
    });
  });

  describe("quote awareness", () => {
    test("pipe inside double quotes is not treated as operator", () => {
      const segs = parseCommandSegments('echo "hello | world"');
      expect(commands(segs)).toEqual(["echo"]);
      expect(operators(segs)).toEqual([]);
    });

    test("pipe inside single quotes is not treated as operator", () => {
      const segs = parseCommandSegments("echo 'hello | world'");
      expect(commands(segs)).toEqual(["echo"]);
      expect(operators(segs)).toEqual([]);
    });

    test("&& inside quotes is not treated as operator", () => {
      const segs = parseCommandSegments('echo "a && b"');
      expect(commands(segs)).toEqual(["echo"]);
      expect(operators(segs)).toEqual([]);
    });
  });

  describe("backslash escapes", () => {
    test("backslash-escaped pipe in grep is not treated as operator", () => {
      const segs = parseCommandSegments(String.raw`grep -i tool\|chat\|render src/`);
      expect(commands(segs)).toEqual(["grep"]);
      expect(operators(segs)).toEqual([]);
    });

    test("real pipe after escaped pipes", () => {
      const segs = parseCommandSegments(String.raw`ls docs/ | grep -i tool\|chat\|render\|inline 2>/dev/null; echo "---"; find docs/ -name "*.md" | head -20`);
      expect(commands(segs)).toEqual(["ls", "grep", "echo", "find", "head"]);
      expect(operators(segs)).toEqual(["|", ";", ";", "|"]);
    });
  });

  describe("edge cases", () => {
    test("empty string", () => {
      const segs = parseCommandSegments("");
      expect(segs).toEqual([{ type: "args", text: "…" }]);
    });

    test("whitespace only", () => {
      const segs = parseCommandSegments("   ");
      expect(segs).toEqual([{ type: "args", text: "   " }]);
    });

    test("command with no args", () => {
      expect(fmt(parseCommandSegments("pwd"))).toBe("[CMD:pwd]");
    });

    test("preserves leading whitespace after operator", () => {
      const segs = parseCommandSegments("a |  b");
      // The space after | is leading whitespace on the next fragment
      expect(commands(segs)).toEqual(["a", "b"]);
    });
  });
});
