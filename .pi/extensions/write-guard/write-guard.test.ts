import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import setupWriteGuard, { normalizeWritePath, isReservedDeviceName } from "./index.ts";

describe("normalizeWritePath", () => {
  const cwd = "/home/me/proj";

  it("rewrites /<bare-filename> to <cwd>/<bare-filename>", () => {
    // The model anchoring at filesystem root is the bug we're fixing.
    expect(normalizeWritePath("/foo.md", cwd)).toEqual({
      path: "/home/me/proj/foo.md",
      rewrittenFrom: "/foo.md",
    });
    expect(normalizeWritePath("/person.md", cwd)).toEqual({
      path: "/home/me/proj/person.md",
      rewrittenFrom: "/person.md",
    });
  });

  it("resolves bare filenames against cwd (no rewrite flag — already cwd-relative)", () => {
    expect(normalizeWritePath("foo.md", cwd)).toEqual({
      path: "/home/me/proj/foo.md",
    });
  });

  it("resolves nested relative paths against cwd", () => {
    expect(normalizeWritePath("sub/foo.md", cwd)).toEqual({
      path: "/home/me/proj/sub/foo.md",
    });
    expect(normalizeWritePath("a/b/c.md", cwd)).toEqual({
      path: "/home/me/proj/a/b/c.md",
    });
  });

  it("leaves genuine absolute paths alone (path has an intermediate directory)", () => {
    // /etc/hosts has an intermediate directory, so it's a legitimate
    // absolute path. We don't rewrite it.
    expect(normalizeWritePath("/etc/hosts", cwd)).toEqual({
      path: "/etc/hosts",
    });
    expect(normalizeWritePath("/tmp/foo.log", cwd)).toEqual({
      path: "/tmp/foo.log",
    });
  });

  it("leaves deep absolute paths in cwd untouched", () => {
    // Model handing back its own cwd-prefixed path: unchanged.
    expect(normalizeWritePath("/home/me/proj/notes/plan.md", cwd)).toEqual({
      path: "/home/me/proj/notes/plan.md",
    });
  });
});

// ── tool_call interceptor: the actual existing-file guard ───────────────────
// pi ships a built-in `write` that overwrites existing files and shadowed our
// old custom tool, so the guard never fired. We now enforce on the `tool_call`
// event, which catches whichever write implementation runs.

function getToolCallHandler() {
  let handler: ((event: any, ctx: any) => any) | undefined;
  const pi = {
    on(name: string, h: (event: any, ctx: any) => any) {
      if (name === "tool_call") handler = h;
    },
  };
  setupWriteGuard(pi as any);
  if (!handler) throw new Error("write-guard did not register a tool_call handler");
  return handler;
}

function makeCtx(cwd: string) {
  const notifies: string[] = [];
  return { cwd, notifies, ui: { notify: (m: string) => notifies.push(m) } };
}

describe("write-guard tool_call interceptor", () => {
  let dir: string;
  let existing: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-"));
    existing = join(dir, "already.md");
    writeFileSync(existing, "old content\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("blocks a write to an existing file with an Edit recipe", async () => {
    const handler = getToolCallHandler();
    const ctx = makeCtx(dir);
    const event = { toolName: "write", input: { path: existing, content: "new" } };
    const result = await handler(event, ctx);
    expect(result?.block).toBe(true);
    expect(result.reason).toContain("already exists");
    expect(result.reason).toContain('"name": "edit"'); // correct pi edit recipe
    expect(result.reason).toContain("oldText");
    expect(ctx.notifies[0]).toMatch(/harness intervention:.*redirected the model to Edit/i);
  });

  it("allows a write to a NEW file (no block) and normalizes the path in place", async () => {
    const handler = getToolCallHandler();
    const ctx = makeCtx(dir);
    const input: any = { path: "fresh.md", content: "hi" };
    const event = { toolName: "write", input };
    const result = await handler(event, ctx);
    expect(result).toBeUndefined();
    expect(input.path).toBe(join(dir, "fresh.md")); // normalized relative → cwd
    expect(ctx.notifies).toHaveLength(0);
  });

  it("rewrites a root-anchored /<bare> path to cwd in place", async () => {
    const handler = getToolCallHandler();
    const ctx = makeCtx(dir);
    const input: any = { path: "/fresh.md", content: "hi" };
    await handler({ toolName: "write", input }, ctx);
    expect(input.path).toBe(join(dir, "fresh.md"));
  });

  it("honors the file_path arg key as well as path", async () => {
    const handler = getToolCallHandler();
    const ctx = makeCtx(dir);
    const result = await handler(
      { toolName: "write", input: { file_path: existing, content: "x" } },
      ctx,
    );
    expect(result?.block).toBe(true);
  });

  it("is case-insensitive on the tool name", async () => {
    const handler = getToolCallHandler();
    const ctx = makeCtx(dir);
    const result = await handler({ toolName: "Write", input: { path: existing } }, ctx);
    expect(result?.block).toBe(true);
  });

  it("ignores non-write tools", async () => {
    const handler = getToolCallHandler();
    const ctx = makeCtx(dir);
    const result = await handler({ toolName: "read", input: { path: existing } }, ctx);
    expect(result).toBeUndefined();
  });

  it("ignores a write call with no path argument", async () => {
    const handler = getToolCallHandler();
    const ctx = makeCtx(dir);
    const result = await handler({ toolName: "write", input: { content: "x" } }, ctx);
    expect(result).toBeUndefined();
  });

  it("blocks a write to a reserved Windows device name (issue #60)", async () => {
    const handler = getToolCallHandler();
    const ctx = makeCtx(dir);
    // Bare `nul` — the model treating it like /dev/null. On Windows this would
    // create an undeletable device-named file; we refuse on every platform.
    const result = await handler({ toolName: "write", input: { path: "nul", content: "x" } }, ctx);
    expect(result?.block).toBe(true);
    expect(result.reason).toContain("reserved Windows device name");
    expect(ctx.notifies[0]).toMatch(/reserved device name/i);
  });

  it("blocks reserved device names with an extension and any case", async () => {
    const handler = getToolCallHandler();
    const ctx = makeCtx(dir);
    for (const name of ["NUL.txt", "Com1", "lpt9.log", "AUX", "con"]) {
      const result = await handler({ toolName: "write", input: { path: name, content: "x" } }, ctx);
      expect(result?.block, `${name} should be blocked`).toBe(true);
    }
  });

  it("allows normal filenames that merely contain a reserved stem", async () => {
    const handler = getToolCallHandler();
    const ctx = makeCtx(dir);
    // `nullable.ts` / `console.log` are NOT reserved — only the exact stem is.
    for (const name of ["nullable.ts", "console.log", "auxiliary.md", "lpt.md"]) {
      const result = await handler({ toolName: "write", input: { path: name, content: "x" } }, ctx);
      expect(result, `${name} should pass`).toBeUndefined();
    }
  });
});

describe("isReservedDeviceName", () => {
  it("matches reserved device names regardless of case or extension", () => {
    for (const name of ["nul", "NUL", "Nul.txt", "con", "PRN", "aux", "com1", "COM9.log", "lpt1", "lpt9.dat"]) {
      expect(isReservedDeviceName(name), name).toBe(true);
      expect(isReservedDeviceName(`/home/me/proj/${name}`), name).toBe(true);
    }
  });
  it("does not match normal names that merely start with a reserved stem", () => {
    for (const name of ["nullable.ts", "console.log", "auxiliary", "com10", "lpt0", "comm", "null.d/real.txt"]) {
      expect(isReservedDeviceName(name), name).toBe(false);
    }
  });
});
