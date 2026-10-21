import assert from "node:assert/strict";
import test from "node:test";
import {
  cmdStartArgv,
  decodeLauncherOutput,
  heartbeatConfirms,
  launchHelperOutsideJob,
  outsideJobCommandLine,
  parseWmiLauncherResult,
  restartLaunchMethods,
  schtasksLauncherCmd,
  schtasksLauncherPs1,
  schtasksRunSpec,
  wmiCreateSucceeded,
  wmiLauncherCommand,
} from "../lib/restart-launch.js";

const SCRIPT = "C:\\Users\\Asus\\AppData\\Local\\Temp\\dsh-purge-official-restart-29516-8fbed6bb.js";

test("launcher stdout keeps ReturnValue and ProcessId from UTF-16 and from NUL-padded text", () => {
  const text = "ReturnValue=0 ProcessId=29516\r\n";
  const decoded = decodeLauncherOutput(Buffer.from(text, "utf16le"));
  const parsed = parseWmiLauncherResult(decoded);
  assert.equal(parsed.returnValue, 0);
  assert.equal(parsed.processId, 29516);
  assert.equal(wmiCreateSucceeded(parsed), true);
  const mangled = Buffer.from(text, "utf16le").toString("utf8");
  assert.equal(parseWmiLauncherResult(decodeLauncherOutput(mangled)).processId, 29516);
  const empty = parseWmiLauncherResult(decodeLauncherOutput(Buffer.alloc(0)));
  assert.equal(empty.returnValue, null);
  assert.equal(empty.processId, null);
  assert.equal(wmiCreateSucceeded(empty), false);
  assert.equal(wmiCreateSucceeded(parseWmiLauncherResult("ReturnValue=0 ProcessId=0")), false);
  assert.equal(wmiCreateSucceeded(parseWmiLauncherResult("ReturnValue=2 ProcessId=9")), false);
  assert.equal(/\$pid\s*=/i.test(wmiLauncherCommand()), false);
  assert.match(wmiLauncherCommand(), /ReturnValue=/);
  assert.match(wmiLauncherCommand(), /ProcessId=/);
});

test("heartbeat accepts an interactive begin and rejects session 0 or a dead helper", () => {
  assert.equal(heartbeatConfirms("begin\r\nbegin session=2\r\n").ok, true);
  assert.equal(heartbeatConfirms("begin\r\nbegin session=0\r\n").reason, "session 0");
  assert.equal(heartbeatConfirms("", { helperPidAlive: false }).reason, "helper exited");
  assert.equal(heartbeatConfirms("begin", { helperPidAlive: false }).reason, "helper exited before session");
  assert.equal(heartbeatConfirms("begin", { helperPidAlive: true, waitExpired: true }).ok, true);
  assert.equal(heartbeatConfirms("begin\r\nbegin session=-1\r\n", { helperPidAlive: true, waitExpired: false }).reason, "waiting");
});

test("launch command lines quote every argument", () => {
  assert.equal(
    outsideJobCommandLine("cscript.exe", ["//nologo", "//B", SCRIPT]),
    `"cscript.exe" "//nologo" "//B" "${SCRIPT}"`,
  );
  assert.deepEqual(cmdStartArgv("cscript.exe", ["//nologo", "//B", SCRIPT]), [
    "/d", "/c", "start", "", "/MIN", "cscript.exe", "//nologo", "//B", SCRIPT,
  ]);
  assert.equal(
    schtasksLauncherCmd("cscript.exe", ["//nologo", "//B", SCRIPT]),
    `@echo off\r\n"cscript.exe" "//nologo" "//B" "${SCRIPT}"\r\n`,
  );
  assert.match(schtasksLauncherPs1("cscript.exe", ["//nologo", SCRIPT]), /Start-Process -FilePath 'cscript.exe'/);
  const spec = schtasksRunSpec("dsh-purge-restart-1", "C:\\Temp\\run.cmd");
  assert.ok(spec.createArgs.includes("/RL"));
  assert.ok(spec.createArgs.includes("LIMITED"));
  assert.ok(spec.createArgs.includes("/SD"));
  assert.ok(spec.createArgs.includes("01/01/2000"));
  assert.ok(spec.createArgs.includes("C:\\Temp\\run.cmd"));
  assert.deepEqual(spec.runArgs, ["/Run", "/TN", "dsh-purge-restart-1"]);
  assert.deepEqual(restartLaunchMethods(), ["wmi", "schtasks", "detached", "cmd-start", "start-process"]);
});

test("wmi exit 0 without a helper begin falls through until a heartbeat exists", async () => {
  const calls = [];
  const logs = [];
  const stopped = [];
  let clock = 0;
  const beats = {
    wmi: "",
    schtasks: "begin\r\nbegin session=0\r\n",
    detached: "begin\r\nbegin session=1\r\n",
  };
  const result = await launchHelperOutsideJob({
    file: "cscript.exe",
    args: ["//nologo", "//B", SCRIPT],
    label: "cscript",
    beatPath: "",
    waitMs: 40,
    pollMs: 10,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    log: (line) => logs.push(line),
    readBeat: () => beats[calls[calls.length - 1]] || "",
    pidAlive: () => false,
    stopPid: (pid) => stopped.push(pid),
    runMethod: async (method) => {
      calls.push(method);
      if (method === "wmi") return { code: 0, output: "ReturnValue=0 ProcessId=29516" };
      if (method === "schtasks") return { started: true, code: 0, processId: 0, helperPid: false, output: "task=dsh-purge-restart-1" };
      return { started: true, code: 0, processId: 77, helperPid: true };
    },
  });
  assert.deepEqual(calls, ["wmi", "schtasks", "detached"]);
  assert.equal(result.ok, true);
  assert.equal(result.method, "detached");
  assert.equal(result.processId, 77);
  assert.ok(logs.some((line) => line.includes("ReturnValue=0") && line.includes("ProcessId=29516")));
  assert.ok(logs.some((line) => line.includes("no heartbeat method=wmi") && line.includes("helper exited")));
  assert.ok(logs.some((line) => line.includes("no heartbeat method=schtasks") && line.includes("session 0")));
  assert.ok(logs.some((line) => line.includes("heartbeat ok method=detached")));
  assert.deepEqual(stopped, [29516]);
});

test("wmi exit 0 with an empty launcher body is not a created process", async () => {
  const calls = [];
  let sleeps = 0;
  const result = await launchHelperOutsideJob({
    file: "cscript.exe",
    args: ["//nologo", "//B", SCRIPT],
    label: "cscript",
    beatPath: "",
    methods: ["wmi"],
    waitMs: 40,
    pollMs: 10,
    now: () => 0,
    sleep: async () => { sleeps += 1; },
    log: () => {},
    readBeat: () => "begin\r\nbegin session=1\r\n",
    pidAlive: () => true,
    runMethod: async (method) => {
      calls.push(method);
      return { code: 0, output: "" };
    },
  });
  assert.deepEqual(calls, ["wmi"]);
  assert.equal(result.ok, false);
  assert.equal(sleeps, 0);
});
