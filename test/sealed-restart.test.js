import assert from "node:assert/strict";
import test from "node:test";
import {
  asarSwapPowerShell,
  harnessRestartWave,
  hostExitsDuringSealedSwap,
  officialRestartScript,
  outsideJobCommandLine,
  planOfficialRestart,
} from "../lib/desktop.js";
import { isWshAscii } from "../lib/official-update.js";

const EXE = "C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe";
const ASAR = "C:\\Program Files\\DeepSeek Harness\\resources\\app.asar";

function script() {
  return officialRestartScript(EXE, ASAR, "D:\\用户\\.dsh");
}

test("sealed restart script stays ASCII and kills the GUI before the host", () => {
  const body = script();
  assert.equal(isWshAscii(body), true);
  const run = body.slice(body.indexOf("log('clean markers ok')"));
  const gui = run.indexOf("log('kill gui ");
  const gone = run.indexOf("log('gui gone')");
  const host = run.indexOf("killAfterGui()");
  const processes = run.indexOf("log('processes gone')");
  const renamed = run.indexOf("log('renamed')");
  const started = run.indexOf("log('started')");
  assert.ok(gui >= 0 && gone > gui && host > gone && processes > host && renamed > processes && started > renamed);
  assert.equal(run.includes("taskkill.exe /T"), false);
  assert.equal(run.includes("taskkill.exe /F /T"), false);
  assert.match(body, /dsh-purge-desktop\.log/);
  assert.match(body, /electron_run_as_node/);
  const beat = body.indexOf("CreateTextFile(beatPath");
  const begin = body.indexOf("log('begin')");
  const shell = body.indexOf("WScript.Shell");
  const wmi = body.indexOf("GetObject(");
  const session0 = body.indexOf("session 0; not starting");
  const guiAt = body.indexOf("log('kill gui ");
  assert.ok(beat >= 0 && begin > beat && begin < shell && shell < wmi && session0 > wmi && guiAt > session0);
  assert.equal(body.includes("log('begin')"), true);
  assert.equal(body.indexOf("log('begin')"), body.lastIndexOf("log('begin')"));
  const plan = planOfficialRestart({
    wshJs: true,
    scriptAscii: isWshAscii(body),
    inflightAgeMs: -1,
    logState: "none",
  });
  assert.equal(plan.kind, "wscript");
  const fallback = planOfficialRestart({
    wshJs: false,
    scriptAscii: false,
    inflightAgeMs: -1,
    logState: "none",
  });
  assert.equal(fallback.kind, "powershell");
});

test("powershell swap logs the same order and does not exit the host on Windows", () => {
  const ps = asarSwapPowerShell();
  const run = ps.slice(ps.indexOf("powershell begin"));
  const gui = run.indexOf("Write-RestartLog ('kill gui '");
  const gone = run.indexOf("Write-RestartLog 'gui gone'");
  const remain = run.indexOf("Stop-Remaining", gone);
  const processes = run.indexOf("Write-RestartLog 'processes gone'");
  const renamed = run.indexOf("Write-RestartLog 'renamed'");
  assert.ok(gui >= 0 && gone > gui && remain > gone && processes > remain && renamed > processes);
  assert.match(ps, /dsh-purge-desktop\.log/);
  const beat = ps.indexOf("$BeatPath");
  const session0 = ps.indexOf("if ($beatSid -eq 0) { exit 1 }");
  const started = ps.indexOf("powershell begin");
  assert.ok(beat >= 0 && session0 > beat && started > session0);
  assert.match(ps, /begin session=/);
  assert.equal(ps.includes("Stop-HarnessInstall"), false);
  assert.equal(hostExitsDuringSealedSwap("win32"), false);
  assert.equal(hostExitsDuringSealedSwap("linux"), true);
});

test("harness process waves keep the host until the GUI is gone", () => {
  const ids = new Set([100, 200]);
  assert.equal(harnessRestartWave({
    name: "DeepSeek Harness.exe",
    executablePath: EXE,
    commandLine: `"${EXE}"`,
    parentProcessId: 4,
  }, EXE, ids), "gui");
  assert.equal(harnessRestartWave({
    name: "DeepSeek Harness.exe",
    executablePath: EXE,
    commandLine: `"${EXE}" ELECTRON_RUN_AS_NODE=1 resources\\app.asar\\lib\\host.js`,
    parentProcessId: 100,
  }, EXE, ids), "after");
  assert.equal(harnessRestartWave({
    name: "DeepSeek Harness.exe",
    executablePath: EXE,
    commandLine: `"${EXE}" --type=renderer`,
    parentProcessId: 100,
  }, EXE, ids), "after");
  assert.equal(harnessRestartWave({
    name: "wscript.exe",
    executablePath: "C:\\Windows\\System32\\wscript.exe",
    commandLine: "wscript.exe //B dsh-purge-official-restart-1.js",
    parentProcessId: 4,
  }, EXE, ids), "skip");
  assert.equal(harnessRestartWave({
    name: "chrome.exe",
    executablePath: "C:\\Program Files\\Google\\Chrome\\chrome.exe",
    commandLine: "chrome",
    parentProcessId: 4,
  }, EXE, ids), "skip");
  const line = outsideJobCommandLine("cscript.exe", ["//nologo", "//B", "C:\\Users\\Asus\\AppData\\Local\\Temp\\restart.js"]);
  assert.equal(line, '"cscript.exe" "//nologo" "//B" "C:\\Users\\Asus\\AppData\\Local\\Temp\\restart.js"');
});
