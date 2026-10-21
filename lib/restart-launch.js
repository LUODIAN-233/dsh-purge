import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// 启动器自己的退出码 0 只说明 Create 调用返回了。helper 没写下 begin 时，
// 密封壳不会被换掉。心跳文件是这次启动真正跑起来的证据。
export const RESTART_HEARTBEAT_WAIT_MS = 5000;

export function restartLaunchMethods() {
  return ["wmi", "schtasks", "detached", "cmd-start", "start-process"];
}

export function outsideJobCommandLine(file, args) {
  const quote = (value) => {
    const text = String(value ?? "");
    if (text.length === 0) return '""';
    return `"${text.replace(/"/g, '\\"')}"`;
  };
  return [file, ...(args || [])].map(quote).join(" ");
}

export function cmdStartArgv(file, args) {
  // /MIN 会新开最小化控制台并马上返回。/B 会让 cscript 留在 cmd 里，cmd 一退出脚本就没了。
  return ["/d", "/c", "start", "", "/MIN", file, ...(args || [])];
}

function cmdQuote(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

export function schtasksLauncherCmd(file, args) {
  const line = [file, ...(args || [])].map(cmdQuote).join(" ");
  return `@echo off\r\n${line}\r\n`;
}

export function schtasksLauncherPs1(file, args) {
  const quote = (value) => `'${String(value ?? "").replace(/'/g, "''")}'`;
  const argList = (args || []).map(quote).join(",");
  return `Start-Process -FilePath ${quote(file)} -ArgumentList @(${argList}) -WindowStyle Hidden\r\n`;
}

export function schtasksRunSpec(taskName, command) {
  return {
    taskName,
    command,
    createArgs: ["/Create", "/F", "/TN", taskName, "/SC", "ONCE", "/SD", "01/01/2000", "/ST", "00:00", "/RL", "LIMITED", "/TR", command],
    runArgs: ["/Run", "/TN", taskName],
    deleteArgs: ["/Delete", "/F", "/TN", taskName],
  };
}

export function wmiLauncherCommand() {
  return [
    "[Console]::OutputEncoding = [System.Text.Encoding]::ASCII",
    "$OutputEncoding = [System.Text.Encoding]::ASCII",
    "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:DSH_PURGE_SPAWN_CMD }",
    "if (-not $r) { Write-Output 'ReturnValue=none ProcessId=0'; exit 1 }",
    "$rv = [int]$r.ReturnValue",
    "$created = 0",
    "if ($null -ne $r.ProcessId) { $created = [int]$r.ProcessId }",
    "Write-Output ('ReturnValue=' + $rv + ' ProcessId=' + $created)",
    "if ($rv -ne 0 -or $created -le 0) { exit 1 }",
    "exit 0",
  ].join("; ");
}

export function startProcessCommand() {
  return [
    "[Console]::OutputEncoding = [System.Text.Encoding]::ASCII",
    "$OutputEncoding = [System.Text.Encoding]::ASCII",
    "$argList = @()",
    "if ($env:DSH_PURGE_SPAWN_ARGS) { $argList = $env:DSH_PURGE_SPAWN_ARGS -split [char]30 }",
    "Start-Process -FilePath $env:DSH_PURGE_SPAWN_FILE -ArgumentList $argList -WindowStyle Hidden",
    "Write-Output 'StartProcess=ok'",
    "exit 0",
  ].join("; ");
}

export function decodeLauncherOutput(input) {
  if (typeof input === "string") {
    return input.replace(/\u0000/g, "").trim();
  }
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return buf.subarray(2).toString("utf16le").replace(/\u0000/g, "").trim();
  }
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0) {
    return buf.toString("utf16le").replace(/\u0000/g, "").trim();
  }
  return buf.toString("utf8").replace(/\u0000/g, "").trim();
}

export function parseWmiLauncherResult(text) {
  const raw = String(text || "");
  const rv = raw.match(/ReturnValue\s*=\s*(-?\d+|none)/i);
  const pid = raw.match(/ProcessId\s*=\s*(\d+)/i);
  return {
    returnValue: !rv || rv[1].toLowerCase() === "none" ? null : Number(rv[1]),
    processId: pid ? Number(pid[1]) : null,
  };
}

export function wmiCreateSucceeded(parsed) {
  return Boolean(parsed && parsed.returnValue === 0 && Number(parsed.processId) > 0);
}

export function heartbeatConfirms(text, { helperPidAlive, waitExpired } = {}) {
  const body = String(text || "");
  const started = /\bbegin\b/.test(body);
  const sessionMatch = body.match(/session=(-?\d+)/);
  const session = sessionMatch ? Number(sessionMatch[1]) : null;
  if (session === 0) return { ok: false, reason: "session 0", session };
  if (started && session != null && session > 0) return { ok: true, reason: `session ${session}`, session };
  if (!started) {
    if (helperPidAlive === false) return { ok: false, reason: "helper exited", session };
    if (waitExpired) return { ok: false, reason: "no begin", session };
    return { ok: false, reason: "waiting", session };
  }
  if (helperPidAlive === false) return { ok: false, reason: "helper exited before session", session };
  if (waitExpired) return { ok: true, reason: session == null ? "begin" : "session unknown", session };
  return { ok: false, reason: "waiting", session };
}

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 400);
}

function clearBeat(beatPath) {
  if (!beatPath) return;
  try { fs.unlinkSync(beatPath); } catch { /* 还没有心跳 */ }
  try {
    if (fs.existsSync(beatPath)) fs.writeFileSync(beatPath, "", "utf8");
  } catch { /* 清不掉就让下一次写入覆盖 */ }
}

function defaultReadBeat(beatPath) {
  if (!beatPath) return "";
  try { return fs.readFileSync(beatPath, "utf8"); } catch { return ""; }
}

function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // 别的会话里的进程会 EPERM。那不是“已经退出”，不能据此换下一种启动方式。
    return err?.code === "EPERM" || err?.code === "EACCES";
  }
}

function defaultStopPid(pid) {
  try {
    process.kill(pid);
    return true;
  } catch (err) {
    return !(err?.code === "EPERM" || err?.code === "EACCES");
  }
}

export async function waitForHelperHeartbeat({
  beatPath,
  helperPid = 0,
  waitMs = RESTART_HEARTBEAT_WAIT_MS,
  pollMs = 200,
  readBeat = defaultReadBeat,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pidAlive = defaultPidAlive,
  now = Date.now,
} = {}) {
  const deadline = now() + waitMs;
  const maxPolls = Math.max(1, Math.ceil(waitMs / Math.max(pollMs, 1))) + 2;
  let last = { ok: false, reason: "no begin" };
  for (let i = 0; i < maxPolls; i += 1) {
    const expired = now() >= deadline || i === maxPolls - 1;
    const alive = helperPid ? Boolean(pidAlive(helperPid)) : undefined;
    last = heartbeatConfirms(readBeat(beatPath), {
      helperPidAlive: helperPid ? alive : undefined,
      waitExpired: expired,
    });
    if (last.ok || last.reason !== "waiting") return last;
    if (expired) return last;
    await sleep(pollMs);
  }
  return last;
}

function collectChild(child, timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    const take = (chunk) => {
      if (!chunk) return;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output: decodeLauncherOutput(Buffer.concat(chunks)) });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 启动器卡住时结束它，helper 不是这个进程 */ }
      finish("timeout");
    }, timeoutMs);
    child.on("error", (err) => finish(err?.message || "error"));
    child.on("close", (code) => finish(code ?? "null"));
  });
}

function spawnCollected(file, args, env) {
  return spawn(file, args, {
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: env || process.env,
  });
}

function afterSpawn(child, onSpawn) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => finish({ started: false, code: "timeout", processId: 0, helperPid: false }), 5000);
    child.on("error", (err) => finish({
      started: false,
      code: err?.message || "error",
      processId: 0,
      helperPid: false,
    }));
    child.on("spawn", () => finish(onSpawn(child)));
  });
}

function asciiText(value) {
  return /^[\x00-\x7f]*$/.test(String(value ?? ""));
}

function writeSchtasksAction(file, args) {
  const id = `${process.pid}-${Date.now().toString(36)}`;
  const tmp = os.tmpdir();
  const payload = [file, ...(args || []), tmp].every(asciiText);
  if (payload) {
    const cmdPath = path.join(tmp, `dsh-purge-restart-task-${id}.cmd`);
    fs.writeFileSync(cmdPath, schtasksLauncherCmd(file, args), "utf8");
    return {
      command: cmdPath,
      cleanupPath: cmdPath,
    };
  }
  const ps1Path = path.join(tmp, `dsh-purge-restart-task-${id}.ps1`);
  fs.writeFileSync(ps1Path, `\uFEFF${schtasksLauncherPs1(file, args)}`, "utf8");
  const quoted = ps1Path.includes(" ") ? `"${ps1Path}"` : ps1Path;
  return {
    command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${quoted}`,
    cleanupPath: ps1Path,
  };
}

async function defaultRunMethod(method, ctx) {
  const file = ctx.file;
  const args = ctx.args || [];
  if (method === "wmi") {
    const child = spawnCollected("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command", wmiLauncherCommand(),
    ], { ...process.env, DSH_PURGE_SPAWN_CMD: outsideJobCommandLine(file, args) });
    const collected = await collectChild(child, 15000);
    const parsed = parseWmiLauncherResult(collected.output);
    return { ...collected, parsed, processId: parsed.processId, helperPid: true, returnValue: parsed.returnValue };
  }
  if (method === "detached") {
    const child = spawn(file, args, {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      shell: false,
    });
    return afterSpawn(child, (spawned) => {
      spawned.unref();
      return { started: true, code: 0, processId: spawned.pid || 0, helperPid: true };
    });
  }
  if (method === "cmd-start") {
    const child = spawn("cmd.exe", cmdStartArgv(file, args), {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      shell: false,
    });
    return afterSpawn(child, (spawned) => {
      spawned.unref();
      return { started: true, code: 0, processId: 0, helperPid: false, output: "cmd /c start /MIN" };
    });
  }
  if (method === "schtasks") {
    const action = writeSchtasksAction(file, args);
    const taskName = `dsh-purge-restart-${process.pid}-${Date.now().toString(36)}`;
    const spec = schtasksRunSpec(taskName, action.command);
    const cleanup = async () => {
      const del = spawn("schtasks.exe", spec.deleteArgs, {
        windowsHide: true,
        shell: false,
        stdio: "ignore",
      });
      del.on("error", () => {});
      del.unref();
      try { fs.unlinkSync(action.cleanupPath); } catch { /* 启动文件已经没了 */ }
    };
    if (spec.command.length > 260) {
      await cleanup();
      return { started: false, code: "long", output: `schtasks /TR is ${spec.command.length} characters`, helperPid: false, processId: 0 };
    }
    const created = await collectChild(spawnCollected("schtasks.exe", spec.createArgs), 15000);
    if (created.code !== 0) {
      return { started: false, code: created.code, output: `task=${taskName} ${created.output}`, helperPid: false, processId: 0, cleanup };
    }
    const ran = await collectChild(spawnCollected("schtasks.exe", spec.runArgs), 15000);
    return {
      started: ran.code === 0,
      code: ran.code,
      output: `task=${taskName} ${ran.output}`,
      helperPid: false,
      processId: 0,
      cleanup,
    };
  }
  if (method === "start-process") {
    const child = spawnCollected("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command", startProcessCommand(),
    ], {
      ...process.env,
      DSH_PURGE_SPAWN_FILE: file,
      DSH_PURGE_SPAWN_ARGS: args.join("\u001e"),
    });
    const collected = await collectChild(child, 15000);
    return {
      started: collected.code === 0,
      code: collected.code,
      output: collected.output,
      helperPid: false,
      processId: 0,
    };
  }
  throw new Error(`unknown launch method ${method}`);
}

export async function launchHelperOutsideJob({
  file,
  args = [],
  label = "helper",
  beatPath = "",
  log = () => {},
  methods = restartLaunchMethods(),
  waitMs = RESTART_HEARTBEAT_WAIT_MS,
  pollMs = 200,
  runMethod,
  readBeat = defaultReadBeat,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pidAlive = defaultPidAlive,
  stopPid = defaultStopPid,
  now = Date.now,
} = {}) {
  const launch = runMethod || ((method, ctx) => defaultRunMethod(method, ctx));
  const tried = [];
  for (const method of methods) {
    let attempt = {};
    try {
      clearBeat(beatPath);
      log(`restart launch try ${method} (${label}): ${outsideJobCommandLine(file, args)}`);
      try {
        attempt = await launch(method, { file, args, label, beatPath, log }) || {};
      } catch (err) {
        log(`restart launch ${method} threw (${label}): ${oneLine(err?.message || err)}`);
        tried.push(method);
        continue;
      }
      tried.push(method);
      if (method === "wmi") {
        const parsed = attempt.parsed || parseWmiLauncherResult(attempt.output || "");
        const returnValue = parsed.returnValue;
        const processId = parsed.processId;
        log(`restart wmi launcher (${label}) exit ${attempt.code} ReturnValue=${returnValue == null ? "none" : returnValue} ProcessId=${processId || 0}`);
        if (!wmiCreateSucceeded(parsed)) {
          log(`restart launch wmi did not create a process (${label})`);
          continue;
        }
        attempt.processId = processId;
        attempt.helperPid = true;
        attempt.returnValue = returnValue;
      } else if (attempt.started === false) {
        log(`restart launch ${method} did not start (${label}): ${oneLine(attempt.output || attempt.code)}`);
        continue;
      } else {
        log(`restart launch spawned ${method} (${label}) pid=${attempt.processId || 0} ${oneLine(attempt.output)}`);
      }
      const verdict = await waitForHelperHeartbeat({
        beatPath,
        helperPid: attempt.helperPid ? attempt.processId : 0,
        waitMs,
        pollMs,
        readBeat,
        sleep,
        pidAlive,
        now,
      });
      if (verdict.ok) {
        log(`restart launch heartbeat ok method=${method} (${label}) ${verdict.reason} pid=${attempt.processId || 0}`);
        return {
          ok: true,
          method,
          processId: attempt.processId || 0,
          returnValue: attempt.returnValue ?? null,
          reason: verdict.reason,
          tried,
        };
      }
      log(`restart launch no heartbeat method=${method} (${label}): ${verdict.reason} pid=${attempt.processId || 0}`);
      if (attempt.helperPid && attempt.processId) {
        let stopped = false;
        try { stopped = stopPid(attempt.processId) !== false; } catch { stopped = false; }
        log(`restart launch ${stopped ? "stopped" : "could not stop"} pid ${attempt.processId} (${method})`);
      }
    } finally {
      if (attempt && typeof attempt.cleanup === "function") {
        try {
          await attempt.cleanup();
        } catch (err) {
          log(`restart launch cleanup ${method} (${label}): ${oneLine(err?.message || err)}`);
        }
      }
    }
  }
  log(`restart launch failed (${label}): no heartbeat after ${tried.join(",")}`);
  return { ok: false, method: "", tried };
}
