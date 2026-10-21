import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { renameAsarAside } from "../lib/extract-asar.js";
import {
  atomicCopyFile,
  formatCliRepairLines,
  renameOverWithRetry,
  repairOfficialCliAfterUnpack,
} from "../lib/core.js";

const STOCK_CMD = [
  "@echo off",
  "set ELECTRON_RUN_AS_NODE=1",
  "\"%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js\" %*",
  "",
].join("\r\n");

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-repair-"));
  const exe = path.join(root, "DeepSeek Harness.exe");
  fs.writeFileSync(exe, "");
  const bin = path.join(root, "resources", "runtime", "cli", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(root, "resources", "app"), { recursive: true });
  const cmd = path.join(bin, "dsh.cmd");
  fs.writeFileSync(cmd, STOCK_CMD);
  return { root, exe, cmd };
}

describe("official CLI repair", { concurrency: 1 }, () => {
  test("backup failure still patches dsh.cmd and does not reject", async () => {
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    const fx = harness();
    try {
      // 备份目标是目录:atomicCopyFile 必须失败,而且以前没 await 时这个拒绝会打死宿主。
      fs.mkdirSync(`${fx.cmd}.dsh-purge.bak`);
      const report = await repairOfficialCliAfterUnpack(fx.exe);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(unhandled.length, 0, unhandled.map((e) => e && e.stack || e).join("\n"));
      assert.equal(report.ok, true);
      const row = report.shims.find((s) => s.path === fx.cmd);
      assert.ok(row, "dsh.cmd row");
      assert.equal(row.status, "patched");
      assert.equal(row.backup, "failed");
      const text = fs.readFileSync(fx.cmd, "utf8");
      assert.match(text, /REM dsh-purge cli entry begin/);
      assert.match(text, /app\.asar\.unpacked/);
      const lines = formatCliRepairLines(report);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /cli-repair: patched backup=failed/);
      assert.match(lines[0], /EPERM|directory/);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("successful backup keeps the original shim and patches the live file", async () => {
    const fx = harness();
    try {
      const report = await repairOfficialCliAfterUnpack(fx.exe);
      assert.equal(report.ok, true);
      const row = report.shims.find((s) => s.path === fx.cmd);
      assert.equal(row.status, "patched");
      assert.equal(row.backup, "saved");
      assert.equal(fs.readFileSync(`${fx.cmd}.dsh-purge.bak`, "utf8"), STOCK_CMD);
      assert.match(fs.readFileSync(fx.cmd, "utf8"), /REM dsh-purge cli entry begin/);
      assert.deepEqual(formatCliRepairLines(report), []);
      const again = await repairOfficialCliAfterUnpack(fx.exe);
      const second = again.shims.find((s) => s.path === fx.cmd);
      assert.equal(second.status, "already");
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describe("atomic rename", () => {
  test("retries ENOENT then succeeds", async () => {
    let n = 0;
    const result = await renameOverWithRetry(async () => {
      n += 1;
      if (n < 3) {
        const error = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      }
    }, "src", "dst", { delayMs: 0, onRetry: async () => undefined });
    assert.equal(n, 3);
    assert.equal(result.attempts, 3);
    assert.equal(result.raced, undefined);
  });

  test("ENOENT with the destination already in place resolves", async () => {
    let n = 0;
    const result = await renameOverWithRetry(async () => {
      n += 1;
      const error = new Error("gone");
      error.code = "ENOENT";
      throw error;
    }, "tmp", "dst", {
      delayMs: 0,
      attempts: 4,
      onRetry: async () => "done",
    });
    assert.equal(n, 1);
    assert.equal(result.raced, true);
  });

  test("does not retry a hard error", async () => {
    await assert.rejects(async () => {
      await renameOverWithRetry(async () => {
        const error = new Error("not a file");
        error.code = "EISDIR";
        throw error;
      }, "src", "dst", { delayMs: 0, attempts: 4 });
    }, (error) => error.code === "EISDIR");
  });

  test("atomicCopyFile replaces an existing file and survives two racers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-copy-"));
    try {
      const src = path.join(dir, "src.txt");
      const dst = path.join(dir, "dst.txt");
      fs.writeFileSync(src, "new-bytes");
      fs.writeFileSync(dst, "old");
      await Promise.all([atomicCopyFile(src, dst), atomicCopyFile(src, dst)]);
      assert.equal(fs.readFileSync(dst, "utf8"), "new-bytes");
      await assert.rejects(atomicCopyFile(path.join(dir, "missing.txt"), dst), (error) => error.code === "ENOENT");
      assert.equal(fs.readFileSync(dst, "utf8"), "new-bytes");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("renameAsarAside moves a real archive and does not throw when it is already gone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-asar-"));
    try {
      const asar = path.join(dir, "app.asar");
      fs.writeFileSync(asar, "archive");
      const moved = renameAsarAside(asar);
      assert.equal(moved.renamed, true);
      assert.equal(fs.existsSync(asar), false);
      assert.equal(fs.readFileSync(`${asar}.bak`, "utf8"), "archive");
      const again = renameAsarAside(asar);
      assert.equal(again.renamed, false);
      assert.equal(again.busy, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("async file helpers are awaited at every call site", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pending = ["lib", "bin"];
  const files = [];
  while (pending.length) {
    const rel = pending.pop();
    const abs = path.join(root, rel);
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(rel, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules") continue;
        pending.push(child);
      } else if (ent.name.endsWith(".js") || ent.name.endsWith(".mjs")) {
        files.push(child);
      }
    }
  }
  const needles = ["atomicCopyFile(", "atomicWriteFile(", "repairOfficialCliAfterUnpack("];
  const offenders = [];
  for (const rel of files) {
    const lines = fs.readFileSync(path.join(root, rel), "utf8").split(/\n/);
    lines.forEach((line, index) => {
      if (line.includes("function ") || line.includes("export async function ")) return;
      if (!needles.some((n) => line.includes(n))) return;
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
      if (!/\bawait\b/.test(line)) offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
