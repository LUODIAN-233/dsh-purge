import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ALL_PATCHES,
  applyReplacementsToText,
  describeIncompleteClean,
  describeUnwrittenHosts,
  formatHostCleanCancel,
} from "../lib/core.js";
import { hostPromptCleanGaps, hostPromptKeepsInject } from "../lib/host-clean.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tailPath = path.join(here, "fixtures", "system-prompt-assemble-tail-0.2.1-rc.2.txt");
const patch40 = ALL_PATCHES.find((item) => item.id === 40);

const TAIL_020 = [
  "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));",
  "\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return transformed;",
  "\t\treturn {",
  "\t\t\t...transformed,",
  "\t\t\tsections: completeSection === void 0 ? transformed.sections : [completeSection],",
  "\t\t\tcontexts: runtimeContextSuppressed ? [] : transformed.contexts",
  "\t\t};",
].join("\n");

function readTail() {
  return fs.readFileSync(tailPath, "utf8");
}

test("0.2.1-rc.2 assemble tail keeps requiredContexts", () => {
  const raw = fs.readFileSync(tailPath);
  assert.equal(raw[0], 0x09);
  assert.equal(raw.includes(Buffer.from("\r\n")), true);
  const text = raw.toString("utf8");
  assert.equal(hostPromptKeepsInject(text), false);
  const gaps = hostPromptCleanGaps(text);
  assert.equal(gaps.some((gap) => gap.includes("#40 COMPLETE_PROMPT_KEEP_INJECT")), true);
  assert.equal(gaps.some((gap) => gap.includes("dsh-system-prompt/lib/index.js")), true);
  assert.equal(gaps.some((gap) => gap.includes("[completeSection]")), true);

  const first = applyReplacementsToText(text, patch40, "dsh-system-prompt/lib/index.js");
  assert.equal(first.changed, true);
  assert.match(first.text, /const requiredContexts = new Set\(\[\.\.\.contextByName\.values\(\)\]/);
  assert.match(first.text, /requiredContexts\.has\(entry\.name\)/);
  assert.equal(first.text.includes("? []"), false);
  assert.equal(first.text.includes("transformed.sections : [completeSection]"), false);
  assert.match(first.text, /\[dsh-purge\] complete prompt keeps inject \+ agent-instructions/);
  assert.equal(hostPromptKeepsInject(first.text), true);
  assert.deepEqual(hostPromptCleanGaps(first.text), []);
  assert.equal(first.text.includes("\r\n"), true);

  const second = applyReplacementsToText(first.text, patch40, "dsh-system-prompt/lib/index.js");
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

test("0.2.0 assemble tail still clears suppressed contexts", () => {
  const first = applyReplacementsToText(TAIL_020, patch40, "dsh-system-prompt/lib/index.js");
  assert.equal(first.changed, true);
  assert.match(first.text, /contexts: runtimeContextSuppressed \? \[\] : transformed\.contexts/);
  assert.equal(first.text.includes("requiredContexts"), false);
  assert.equal(first.text.includes("transformed.sections : [completeSection]"), false);
  assert.equal(hostPromptKeepsInject(first.text), true);
  const second = applyReplacementsToText(first.text, patch40, "dsh-system-prompt/lib/index.js");
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

test("space indent and a trailing comma on the contexts line still match 0.2.1", () => {
  const spaced = readTail().replace(/\t/g, "  ").replace(/\r\n/g, "\n");
  const withComma = spaced.replace(
    "requiredContexts.has(entry.name)) : transformed.contexts",
    "requiredContexts.has(entry.name)) : transformed.contexts,",
  );
  const applied = applyReplacementsToText(withComma, patch40, "dsh-system-prompt/lib/index.js");
  assert.equal(applied.changed, true);
  assert.match(applied.text, /requiredContexts\.has\(entry\.name\)/);
  assert.equal(applied.text.includes("? []"), false);
  assert.equal(hostPromptKeepsInject(applied.text), true);
});

test("restart cancel names the patch and file", () => {
  const msg = formatHostCleanCancel("unwritten", hostPromptCleanGaps(readTail()).join("；"));
  assert.match(msg, /^清洗没有写进全部宿主，已取消重启：/);
  assert.match(msg, /#40 COMPLETE_PROMPT_KEEP_INJECT/);
  assert.match(msg, /dsh-system-prompt\/lib\/index\.js/);

  const incomplete = formatHostCleanCancel("incomplete", describeIncompleteClean({
    pending: [40],
    blocking: [{
      patch_id: 66,
      name: "SYSTEM_PROMPT_RENDER_GUARD",
      status: "write_error:EBUSY",
      path: "C:/Program Files/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js",
    }],
    flashOk: false,
  }));
  assert.match(incomplete, /^清洗没有完成，已取消重启：/);
  assert.match(incomplete, /待写入 #40 COMPLETE_PROMPT_KEEP_INJECT/);
  assert.match(incomplete, /#66 SYSTEM_PROMPT_RENDER_GUARD write_error:EBUSY/);
  assert.match(incomplete, /dsh-system-prompt\/lib\/index\.js/);
  assert.match(incomplete, /dsh\.cmd 闪退静默未写上/);
});

test("describeUnwrittenHosts reads dsh-system-prompt/lib/index.js", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-host-"));
  const fp = path.join(dir, "dsh-system-prompt", "lib", "index.js");
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, readTail());
  try {
    const detail = describeUnwrittenHosts([{ aiBase: dir, hostWritten: false }]);
    assert.match(detail, /#40 COMPLETE_PROMPT_KEEP_INJECT/);
    assert.match(detail, /dsh-system-prompt\/lib\/index\.js/);
    const written = describeUnwrittenHosts([{ aiBase: dir, hostWritten: true }]);
    assert.equal(written, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("identity sentence still in the module is named as #25", () => {
  const text = [
    "You are an AI agent powered by DeepSeek Harness.",
    "const transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));",
    "sections: completeSection === void 0 ? transformed.sections : [completeSection],",
  ].join("\n");
  const gaps = hostPromptCleanGaps(text);
  assert.equal(gaps.some((gap) => gap.includes("#25 HARNESS_IDENTITY_STRIP")), true);
  assert.equal(gaps.some((gap) => gap.includes("#40 COMPLETE_PROMPT_KEEP_INJECT")), true);
});
