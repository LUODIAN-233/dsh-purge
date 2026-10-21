import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { isWshAscii, wshLiteral } from "./official-update.js";
import { asarArchiveIsFile, hostFs } from "./extract-asar.js";
import { hostPromptKeepsInject } from "./host-clean.js";
import { atomicCopyFile, atomicWriteSync } from "./core.js";

function restartUniqSuffix() {
  return `${process.pid}-${randomBytes(4).toString("hex")}`;
}

// 无归档时用 node:fs。app.asar 还在时不能把映射出来的 resources/app 当成已经解开。
const fs = hostFs;

// [dsh-purge-fix 2026-10-09] console.warn 写 host stderr → main.js:3729 host.exitPromise
// fail 回调把最后一行 stderr 当 Error reason。helper restart 期间任何 warn 都可能
// 被误判成 crash log。改走内部文件,不污染 stderr。
const INTERNAL_LOG_PATH = path.join(os.tmpdir(), "dsh-purge-desktop.log");
function logInternal(msg) {
  try {
    const line = `${new Date().toISOString()} [dsh-purge] ${String(msg)}\n`;
    fs.appendFileSync(INTERNAL_LOG_PATH, line, "utf8");
  } catch {
    /* 日志写不进去就吞,绝不走 stderr */
  }
}

/** 启动一次：清掉旧版本留下的无 pid 后缀的 restart 脚本/日志（超过 24h）。 */
export function cleanupLegacyRestartScripts() {
  const tmp = os.tmpdir();
  let entries = [];
  try { entries = fs.readdirSync(tmp); } catch { return; }
  const pat = /^dsh-purge-official-restart(?:-[0-9a-f-]+)?\.(?:js|cmd|log)$/i;
  for (const name of entries) {
    if (!pat.test(name)) continue;
    const fp = path.join(tmp, name);
    try {
      const st = fs.statSync(fp);
      if (Date.now() - st.mtimeMs > 24 * 60 * 60 * 1000) {
        fs.unlinkSync(fp);
      }
    } catch { /* ignore */ }
  }
}

/** 路径落在 `app.asar/...` 里面。`app.asar` 文件本身和 `app.asar.unpacked` 不算。 */
export function isAsarSealedPath(p) {
  const parts = String(p || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 2) return false;
  return parts.slice(0, -1).some((seg) => {
    const s = seg.toLowerCase();
    return s.endsWith(".asar") && !s.endsWith(".asar.unpacked");
  });
}

function isFile(fp) {
  try {
    if (isAsarSealedPath(fp)) return false;
    return Boolean(fp) && fs.existsSync(fp) && fs.statSync(fp).isFile();
  } catch {
    return false;
  }
}

function isDir(fp) {
  try {
    if (isAsarSealedPath(fp)) return false;
    return Boolean(fp) && fs.existsSync(fp) && fs.statSync(fp).isDirectory();
  } catch {
    return false;
  }
}

function isAiBase(p) {
  return Boolean(p) && isDir(path.join(p, "dsh-agent-instructions", "lib"));
}

function uniquePaths(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item) continue;
    const n = path.normalize(item);
    const key = n.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

function slashNorm(p) {
  return path.normalize(String(p || "")).replace(/\\/g, "/").toLowerCase();
}

function isSubPath(child, root) {
  const c = slashNorm(child).replace(/\/+$/, "");
  const r = slashNorm(root).replace(/\/+$/, "");
  if (!c || !r || r === "/") return false;
  if (/^[a-z]:$/.test(r)) return false;
  return c === r || c.startsWith(`${r}/`);
}

/**
 * 社区桌面、官方 exe、.app 包才算安装树。
 * 只是上级文件夹叫 DeepSeek Harness 不算：npm 前缀和配置目录经常用这个名字，
 * 按名字整棵排除的话，Web 的身份句和 complete 注入补丁会被跳过。
 */
export function looksLikeDesktopName(p) {
  const n = slashNorm(p);
  if (!n) return false;
  return (
    n.includes("/dsh desktop/") ||
    n.includes("/dsh desktop.app/") ||
    n.endsWith("/dsh desktop") ||
    n.endsWith("/dsh desktop.app") ||
    n.includes("dsh-desktop") ||
    n.includes("/deepseek harness/") ||
    n.includes("/deepseek-harness/") ||
    n.includes("/deepseekharness") ||
    /\/deepseek[\s._-]*harness(\/|$)/.test(n) ||
    n.includes("/deepseek harness.app/") ||
    n.endsWith("/deepseek harness.app") ||
    /\/dsh desktop\.exe$/i.test(n) ||
    /\/deepseek[\s._-]*harness\.exe$/i.test(n)
  );
}

const OFFICIAL_HARNESS_BASES = new Set([
  "deepseek harness.exe",
  "deepseek-harness.exe",
  "deepseek harness",
  "deepseek-harness",
]);

/**
 * 只把「路径自己那一段」当桌面名字，不看祖先目录。
 *
 * 上面那段注释说要避免的事，原实现其实在做：`n.includes("/deepseek harness/")`
 * 会命中任意祖先目录。而 npm 前缀（`D:\DeepSeek Harness\npm-global\…`）和
 * DSH_HOME 的父目录（`D:\DeepSeek Harness\.dsh` 的上级）恰好都叫这个名字 ——
 * 于是 Web 安装根被判成桌面，findAiBaseWeb 里每一处
 * `!isInsideDesktopInstall(cand)` 守卫都会把正确答案踢掉，Web 面定位不到宿主。
 *
 * 真正的桌面安装靠结构标记判定：路径里含 `/resources/app/`、
 * `/resources/app.asar.unpacked/` 或 `/contents/resources/`（见 inferDesktopInstallDir）。
 * 名字只作为「这一级目录本身就是安装根」的兜底。
 */
export function looksLikeDesktopNameTail(p) {
  const n = slashNorm(p).toLowerCase().replace(/\/+$/, "");
  if (!n) return false;
  const cut = n.lastIndexOf("/");
  const tail = cut >= 0 ? n.slice(cut + 1) : n;
  if (!tail) return false;
  return (
    tail === "dsh desktop" ||
    tail === "dsh desktop.app" ||
    tail === "deepseek harness" ||
    tail === "deepseek harness.app" ||
    tail === "deepseek-harness" ||
    tail === "deepseekharness" ||
    /^dsh-desktop/.test(tail) ||
    /^deepseek[\s._-]*harness(\.exe)?$/.test(tail)
  );
}

function sameBase(name, expected) {
  return String(name || "").toLowerCase() === expected;
}

export function isDesktopExecutable(fp) {
  const base = path.basename(String(fp || "")).toLowerCase();
  if (base === "dsh desktop.exe" || base === "dsh desktop") return true;
  if (OFFICIAL_HARNESS_BASES.has(base)) return true;
  return /^deepseek[\s._-]*harness(\.exe)?$/.test(base);
}

/** 只有官方 DeepSeek Harness 会把宿主封进 app.asar 并在「应用」时解开。第三方 DSH Desktop 不走这条。 */
export function isOfficialHarnessExecutable(fp) {
  const base = path.basename(String(fp || "")).toLowerCase();
  if (OFFICIAL_HARNESS_BASES.has(base)) return true;
  return /^deepseek[\s._-]*harness(\.exe)?$/.test(base);
}

/** 某个安装目录下可能的 resources 文件夹（mac 大小写敏感盘要 Resources 和 resources 都试）。 */
export function resourceDirCandidates(installDir) {
  if (!installDir) return [];
  const name = path.basename(installDir);
  if (sameBase(name, "macos")) {
    const contents = path.dirname(installDir);
    return [path.join(contents, "Resources"), path.join(contents, "resources")];
  }
  if (sameBase(name, "contents")) {
    return [path.join(installDir, "Resources"), path.join(installDir, "resources")];
  }
  if (name.toLowerCase().endsWith(".app")) {
    return [
      path.join(installDir, "Contents", "Resources"),
      path.join(installDir, "Contents", "resources"),
    ];
  }
  if (sameBase(name, "resources")) return [installDir];
  return [path.join(installDir, "resources"), path.join(installDir, "Resources")];
}

/** 官方宿主的 resources 目录。已存在的 app.asar 优先，否则用该平台的常规目录名。 */
export function resourcesDirForExecutable(exe) {
  const exeDir = path.dirname(path.normalize(String(exe || "")));
  if (!exeDir) return "";
  const cands = resourceDirCandidates(exeDir);
  const withAsar = cands.find((dir) => isFile(path.join(dir, "app.asar")));
  if (withAsar) return withAsar;
  const existing = cands.find((dir) => isDir(dir));
  if (existing) return existing;
  return cands[0] || "";
}

export function appAsarPath(exe) {
  const dir = resourcesDirForExecutable(exe);
  return dir ? path.join(dir, "app.asar") : "";
}

export function appDirForExecutable(exe) {
  const dir = resourcesDirForExecutable(exe);
  return dir ? path.join(dir, "app") : "";
}

function exeCandidatesBeside(dir) {
  if (!dir) return [];
  return [
    path.join(dir, "DeepSeek Harness.exe"),
    path.join(dir, "deepseek-harness.exe"),
    path.join(dir, "DeepSeek Harness"),
    path.join(dir, "deepseek-harness"),
    path.join(dir, "DSH Desktop.exe"),
    path.join(dir, "DSH Desktop"),
    path.join(dir, "MacOS", "DeepSeek Harness"),
    path.join(dir, "MacOS", "deepseek-harness"),
    path.join(dir, "MacOS", "DSH Desktop"),
    path.join(dir, "Contents", "MacOS", "DeepSeek Harness"),
    path.join(dir, "Contents", "MacOS", "deepseek-harness"),
    path.join(dir, "Contents", "MacOS", "DSH Desktop"),
  ];
}

function firstExistingExe(dirs) {
  for (const dir of dirs) {
    if (!dir) continue;
    for (const cand of exeCandidatesBeside(dir)) {
      if (isFile(cand)) return path.normalize(cand);
    }
  }
  return "";
}

const APP_SCRIPT_RE = /(desktop-cli|host-process-entry)\.js$/i;

function installDirsFromAppScript(scriptPath) {
  if (!scriptPath) return [];
  const abs = path.resolve(scriptPath);
  const lib = path.dirname(abs);
  const app = path.dirname(lib);
  const resources = path.dirname(app);
  const install = path.dirname(resources);
  return uniquePaths([lib, app, resources, install]);
}

/** 从任意 `.../resources/app/...` 树反推安装目录（不要求文件夹叫 DSH Desktop）。 */
export function inferDesktopInstallDir(p) {
  const raw = path.normalize(String(p || "")).replace(/\\/g, "/");
  const n = raw.toLowerCase();
  if (!n) return "";
  const markers = [
    "/resources/app.asar.unpacked/",
    "/resources/app/",
    "/contents/resources/",
  ];
  for (const marker of markers) {
    const i = n.indexOf(marker);
    if (i <= 0) continue;
    return path.normalize(raw.slice(0, i));
  }
  return "";
}

function extraInstallsFromEnv(env = process.env) {
  return String(env.DSH_DESKTOP_INSTALL || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function trustedInstallDir(dir) {
  if (!dir) return false;
  if (looksLikeDesktopName(dir)) return true;
  if (firstExistingExe([dir])) return true;
  return (
    isAiBase(path.join(dir, "resources", "app", "dsh", "node_modules", "@deepseek-ai")) ||
    isAiBase(path.join(dir, "resources", "app", "node_modules", "@deepseek-ai")) ||
    isAiBase(path.join(dir, "resources", "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai")) ||
    isAiBase(path.join(dir, "resources", "app.asar.unpacked", "node_modules", "@deepseek-ai"))
  );
}

const REGISTRY_INSTALL_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$names = @('DeepSeek Harness','DSH Desktop')
$roots = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)
$rows = foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if (-not $p.DisplayName) { return }
    $hit = $false
    foreach ($n in $names) { if ($p.DisplayName -like ('*' + $n + '*')) { $hit = $true } }
    if (-not $hit) { return }
    [pscustomobject]@{
      InstallLocation = [string]$p.InstallLocation
      DisplayIcon = [string]$p.DisplayIcon
      UninstallString = [string]$p.UninstallString
    }
  }
}
if ($rows) { @($rows) | ConvertTo-Json -Compress }
`.trim();

function exeDirFromRegistryValue(value) {
  let val = String(value || "").trim();
  const quoted = val.match(/^"([^"]+)"/);
  if (quoted) val = quoted[1];
  val = val.replace(/,0$/, "").trim();
  if (!val) return "";
  return path.normalize(path.dirname(val));
}

let cachedRegistryDirs;
/** 从卸载登记读安装目录。盘符跟着用户安装位置，不写死。 */
export function registryInstallDirs() {
  if (cachedRegistryDirs !== undefined) return cachedRegistryDirs;
  if (process.platform !== "win32") {
    cachedRegistryDirs = [];
    return cachedRegistryDirs;
  }
  let text = "";
  try {
    text = execFileSync("powershell.exe", ["-NoProfile", "-Command", REGISTRY_INSTALL_SCRIPT], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 8 << 20,
    });
  } catch {
    return [];
  }
  let rows = [];
  try {
    const parsed = JSON.parse(String(text || "").replace(/^\uFEFF/, "").trim() || "[]");
    rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
  const found = [];
  for (const row of rows) {
    const location = String(row.InstallLocation || "").trim();
    if (location) found.push(path.normalize(location));
    found.push(exeDirFromRegistryValue(row.DisplayIcon));
    found.push(exeDirFromRegistryValue(row.UninstallString));
  }
  const result = uniquePaths(found).filter((dir) => firstExistingExe([dir]));
  if (result.length > 0) cachedRegistryDirs = result;
  return result;
}

const PORTABLE_INSTALL_NAMES = [
  "DeepSeek Harness",
  "DeepseekHarnessDesktop",
  "DeepSeekHarnessDesktop",
  "DSH Desktop",
  "deepseek-harness",
];

function homeSiblingInstalls(env = process.env) {
  const homes = [env.DSH_HOME, env.DSH_BASE].filter(Boolean);
  const dirs = [];
  for (const raw of homes) {
    const start = path.normalize(String(raw));
    dirs.push(start, path.dirname(start), path.dirname(path.dirname(start)));
  }
  return uniquePaths(dirs).filter((dir) => firstExistingExe([dir]));
}

/** 用户目录和各盘根下一层常见文件夹名。不扫整盘。 */
function portableInstallGuesses(env = process.env) {
  const home = os.homedir();
  const cands = [];
  for (const folder of ["Desktop", "Documents", "Downloads"]) {
    for (const name of PORTABLE_INSTALL_NAMES) {
      cands.push(path.join(home, folder, name));
    }
  }
  for (const name of PORTABLE_INSTALL_NAMES) {
    cands.push(path.join(home, name));
  }
  if (process.platform === "win32") {
    for (const letter of "CDEFGHI") {
      for (const name of PORTABLE_INSTALL_NAMES) {
        cands.push(`${letter}:\\${name}`);
      }
    }
  }
  return uniquePaths(cands).filter((dir) => firstExistingExe([dir]));
}

function walkParentsForOfficialExe(start, maxUp = 8) {
  if (!start) return "";
  let dir = "";
  try {
    const abs = path.resolve(String(start));
    dir = isDir(abs) ? abs : path.dirname(abs);
  } catch {
    return "";
  }
  for (let i = 0; i < maxUp && dir; i += 1) {
    const hit = firstExistingExe([dir]);
    if (hit) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

const PROCESS_EXE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$re = 'DeepSeek Harness\\.exe$|deepseek-harness\\.exe$|DSH Desktop\\.exe$'
$paths = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath -match $re } |
  Select-Object -ExpandProperty ExecutablePath)
if ($paths) { @($paths) | ConvertTo-Json -Compress }
`.trim();

let cachedRunningExes;
function runningOfficialExecutables() {
  if (cachedRunningExes !== undefined) return cachedRunningExes;
  if (process.platform !== "win32") {
    cachedRunningExes = [];
    return cachedRunningExes;
  }
  let text = "";
  try {
    text = execFileSync("powershell.exe", ["-NoProfile", "-Command", PROCESS_EXE_SCRIPT], {
      encoding: "utf8",
      windowsHide: true,
      // 15s 会把启动期的 UI 线程卡 15s;Win32_Process 枚举 1-3s 够用,超时直接退不缓存。
      timeout: 6000,
      maxBuffer: 8 << 20,
    });
  } catch {
    // 探测失败不缓存空结果，否则整次进程都找不到正在跑的客户端。
    return [];
  }
  let rows = [];
  try {
    const parsed = JSON.parse(String(text || "").replace(/^\uFEFF/, "").trim() || "[]");
    rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
  // 结果为空也不缓存：客户端可能稍后才启动，否则本进程后续永远找不到它。
  const result = uniquePaths(rows.map((item) => String(item || "").trim()).filter((fp) => isDesktopExecutable(fp) && isFile(fp)));
  if (result.length > 0) cachedRunningExes = result;
  return result;
}

const SHORTCUT_EXE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$shell = New-Object -ComObject WScript.Shell
$roots = @(
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory')
) | Where-Object { $_ }
$pats = @('*DeepSeek*Harness*.lnk','*DSH Desktop*.lnk','*deepseek-harness*.lnk')
$out = New-Object System.Collections.Generic.List[string]
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  foreach ($pat in $pats) {
    Get-ChildItem -LiteralPath $root -Filter $pat -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 16 | ForEach-Object {
        try {
          $t = $shell.CreateShortcut($_.FullName).TargetPath
          if ($t) { $out.Add([string]$t) }
        } catch {}
      }
  }
}
if ($out.Count) { @($out) | ConvertTo-Json -Compress }
`.trim();

let cachedShortcutExes;
function shortcutOfficialExecutables() {
  if (cachedShortcutExes !== undefined) return cachedShortcutExes;
  if (process.platform !== "win32") {
    cachedShortcutExes = [];
    return cachedShortcutExes;
  }
  let text = "";
  try {
    text = execFileSync("powershell.exe", ["-NoProfile", "-Command", SHORTCUT_EXE_SCRIPT], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 8 << 20,
    });
  } catch {
    return [];
  }
  let rows = [];
  try {
    const parsed = JSON.parse(String(text || "").replace(/^\uFEFF/, "").trim() || "[]");
    rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
  const result = uniquePaths(rows.map((item) => String(item || "").trim()).filter((fp) => isDesktopExecutable(fp) && isFile(fp)));
  if (result.length > 0) cachedShortcutExes = result;
  return result;
}

/** 点「应用」前清掉失败的空缓存，重新找本机 exe。 */
export function clearDesktopLocateCache() {
  cachedRunningExes = undefined;
  cachedShortcutExes = undefined;
  cachedRegistryDirs = undefined;
}

function extraDiscoveredInstallDirs(env = process.env, input = {}) {
  const cheap = [
    ...homeSiblingInstalls(env),
    ...portableInstallGuesses(env),
  ];
  if (input.discover !== true) return uniquePaths(cheap);
  return uniquePaths([
    ...cheap,
    ...runningOfficialExecutables().map((exe) => path.dirname(exe)),
    ...shortcutOfficialExecutables().map((exe) => path.dirname(exe)),
  ]);
}

/** NSIS / 商店默认位置；不是全盘扫描。discover 才查注册表 / 进程 / 快捷方式。 */
export function commonDesktopInstallDirs(env = process.env, input = {}) {
  const discover = input.discover === true;
  const home = os.homedir();
  const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const pf = env.ProgramFiles || "";
  const pf86 = env["ProgramFiles(x86)"] || "";
  return uniquePaths([
    ...extraInstallsFromEnv(env).filter(trustedInstallDir),
    ...(discover ? registryInstallDirs() : []),
    ...extraDiscoveredInstallDirs(env, { discover }),
    path.join(local, "Programs", "DeepSeek Harness"),
    path.join(local, "Programs", "DSH Desktop"),
    path.join(local, "DeepSeek Harness"),
    ...(pf
      ? [path.join(pf, "DeepSeek Harness"), path.join(pf, "DSH Desktop")]
      : []),
    ...(pf86
      ? [path.join(pf86, "DeepSeek Harness"), path.join(pf86, "DSH Desktop")]
      : []),
    "/Applications/DeepSeek Harness.app",
    "/Applications/DSH Desktop.app",
    path.join(home, "Applications", "DeepSeek Harness.app"),
    path.join(home, "Applications", "DSH Desktop.app"),
    "/opt/DeepSeek Harness",
    "/opt/deepseek-harness",
    "/usr/lib/DeepSeek Harness",
    "/usr/lib/deepseek-harness",
    "/usr/share/deepseek-harness",
    path.join(home, ".local", "share", "DeepSeek Harness"),
    path.join(home, ".local", "share", "deepseek-harness"),
    "/opt/DSH Desktop",
    "/usr/lib/dsh-desktop",
  ]);
}

export function listDesktopInstallRoots(input = {}) {
  const execPath = input.execPath ?? process.execPath;
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  const argv = input.argv ?? process.argv;
  const env = input.env ?? process.env;
  const roots = [];

  if (isDesktopExecutable(execPath)) {
    const dir = path.dirname(path.normalize(execPath));
    roots.push(dir);
    if (sameBase(path.basename(dir), "macos")) {
      const contents = path.dirname(dir);
      roots.push(
        contents,
        path.join(contents, "Resources"),
        path.join(contents, "resources"),
        path.dirname(contents),
      );
    }
  }

  if (resourcesPath) {
    const res = path.normalize(resourcesPath);
    roots.push(res, path.dirname(res), path.join(res, "app"), path.join(res, "app.asar.unpacked"));
  }

  for (const arg of argv) {
    if (typeof arg === "string" && APP_SCRIPT_RE.test(arg)) {
      roots.push(...installDirsFromAppScript(arg));
    }
  }

  for (const extra of extraInstallsFromEnv(env)) {
    if (trustedInstallDir(extra)) roots.push(extra);
  }
  return uniquePaths(roots);
}

/**
 * 是否落在社区 Desktop 安装树。
 * 不依赖盘符、也不要求文件夹叫 “DSH Desktop”：
 * 当前进程的 exe / resources / host-process-entry、旁边真有桌面 exe，或社区安装目录名。
 */
export function isInsideDesktopInstall(p, input = {}) {
  if (!p) return false;
  // 名字兜底只看路径尾部那一段，不看祖先目录名 —— 见 looksLikeDesktopNameTail。
  if (looksLikeDesktopNameTail(p)) return true;
  const roots = listDesktopInstallRoots(input);
  if (roots.some((root) => isSubPath(p, root))) return true;
  const inferred = inferDesktopInstallDir(p);
  if (!inferred) return false;
  if (roots.some((root) => isSubPath(inferred, root) || isSubPath(root, inferred))) return true;
  return Boolean(firstExistingExe([inferred]));
}

export function findDesktopAppExecutable(input = {}) {
  const execPath = input.execPath ?? process.execPath;
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  const argv = input.argv ?? process.argv;
  const env = input.env ?? process.env;
  const discover = input.discover === true;

  if (isDesktopExecutable(execPath) && isFile(execPath)) return path.normalize(execPath);

  if (resourcesPath) {
    const hit = firstExistingExe([path.dirname(path.normalize(resourcesPath))]);
    if (hit) return hit;
  }

  for (const arg of argv) {
    if (typeof arg !== "string" || !APP_SCRIPT_RE.test(arg)) continue;
    const hit = firstExistingExe(installDirsFromAppScript(arg));
    if (hit) return hit;
  }

  const walkStarts = [execPath, resourcesPath, env.DSH_HOME, env.DSH_BASE];
  try { walkStarts.push(process.cwd()); } catch { /* ignore */ }
  for (const arg of argv) {
    if (typeof arg === "string") walkStarts.push(arg);
  }
  for (const start of walkStarts) {
    const hit = walkParentsForOfficialExe(start);
    if (hit) return hit;
  }

  if (discover) {
    const running = runningOfficialExecutables();
    if (running[0]) return running[0];
    const shortcuts = shortcutOfficialExecutables();
    if (shortcuts[0]) return shortcuts[0];
  }

  const guessed = firstExistingExe([
    ...extraInstallsFromEnv(env),
    ...commonDesktopInstallDirs(env, { discover }),
  ]);
  return guessed || "";
}

function packageRootsFromInstall(installDir) {
  if (!installDir) return [];
  const out = [];
  for (const resources of resourceDirCandidates(installDir)) {
    out.push(
      path.join(resources, "app", "dsh", "node_modules", "@deepseek-ai"),
      path.join(resources, "app", "node_modules", "@deepseek-ai"),
      path.join(resources, "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai"),
      path.join(resources, "app.asar.unpacked", "node_modules", "@deepseek-ai"),
    );
  }
  return out;
}

export function listDesktopPackageRoots(input = {}) {
  const execPath = input.execPath ?? process.execPath;
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  const argv = input.argv ?? process.argv;
  const env = input.env ?? process.env;
  const discover = input.discover === true;
  const cands = [];

  if (resourcesPath) {
    cands.push(
      path.join(resourcesPath, "app", "dsh", "node_modules", "@deepseek-ai"),
      path.join(resourcesPath, "app", "node_modules", "@deepseek-ai"),
      path.join(resourcesPath, "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai"),
      path.join(resourcesPath, "app.asar.unpacked", "node_modules", "@deepseek-ai"),
    );
  }

  if (isDesktopExecutable(execPath)) {
    cands.push(...packageRootsFromInstall(path.dirname(execPath)));
  }

  const exe = findDesktopAppExecutable(input);
  if (exe) cands.push(...packageRootsFromInstall(path.dirname(exe)));

  for (const arg of argv) {
    if (typeof arg !== "string" || !APP_SCRIPT_RE.test(arg)) continue;
    const appDir = path.dirname(path.dirname(path.resolve(arg)));
    cands.push(path.join(appDir, "node_modules", "@deepseek-ai"));
    cands.push(path.join(appDir, "dsh", "node_modules", "@deepseek-ai"));
    cands.push(...packageRootsFromInstall(path.dirname(path.dirname(appDir))));
  }

  const localHits = uniquePaths(cands).filter(isAiBase);
  // 已经在某个桌面 exe 里时，只改这一份。旁边装了另一种客户端也不能被带上。
  if (isDesktopExecutable(execPath)) return localHits;
  // 启动自愈：exe / 环境 / 常见目录已经够用。注册表和快捷方式留给点「应用」。
  if (!discover && localHits.length) return localHits;

  for (const install of commonDesktopInstallDirs(env, { discover })) {
    cands.push(...packageRootsFromInstall(install));
  }

  return uniquePaths(cands).filter(isAiBase);
}

export function resolveDesktopAiBase(input = {}) {
  return listDesktopPackageRoots(input)[0] || null;
}

export function isSealedRuntimeDir(dir) {
  if (!dir) return false;
  const n = path.normalize(dir).replace(/\\/g, "/").toLowerCase();
  if (!/(^|\/)bin\/?$/.test(n)) return false;
  return (
    n.includes("/host-commands/") ||
    n.includes("/runtime-commands/") ||
    n.includes("/dsh desktop/")
  );
}

export function sealedRuntimeRoots(env = process.env) {
  const home = os.homedir();
  const appdata = env.APPDATA || path.join(home, "AppData", "Roaming");
  const localapp = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  return uniquePaths([
    path.join(appdata, "DSH Desktop", "host-commands"),
    path.join(appdata, "DSH Desktop", "runtime-commands"),
    path.join(localapp, "DSH Desktop", "host-commands"),
    path.join(localapp, "DSH Desktop", "runtime-commands"),
    path.join(home, "Library", "Application Support", "DSH Desktop", "host-commands"),
  ]);
}

function walkBinDirs(dir, out, depth) {
  if (depth < 0 || !isDir(dir)) return;
  const n = dir.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)bin$/.test(n)) {
    out.push(path.normalize(dir));
    return;
  }
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    if (ent.isDirectory()) walkBinDirs(path.join(dir, ent.name), out, depth - 1);
  }
}

export function listSealedRuntimeBins(env = process.env) {
  const out = [];
  for (const root of sealedRuntimeRoots(env)) walkBinDirs(root, out, 5);
  return uniquePaths(out).filter(isSealedRuntimeDir);
}

export function restartNote() {
  return "正在重启桌面应用…";
}

export function restartPlan(input = {}) {
  const exe = findDesktopAppExecutable(input);
  if (!exe) {
    return { kind: "desktop", execPath: "", argv: [], cwd: "", error: "未找到 DSH Desktop.exe，无法重启桌面应用" };
  }
  return {
    kind: "desktop",
    execPath: exe,
    argv: [],
    cwd: path.dirname(exe),
  };
}

function helperEnv(payload) {
  const env = { ...process.env };
  delete env.DSH_PERMISSION_MODE;
  env.ELECTRON_RUN_AS_NODE = "1";
  env.DSH_PURGE_RESTART = JSON.stringify(payload);
  return env;
}

// #85: 宿主进程里同步 taskkill Electron 会让 Job Object 把宿主一起收掉,helper 还没
// 拉起来。密封包第一次重启时壳仍是 app.asar 里的旧 close 回调,宿主先退出就会弹
// "dsh desktop host stopped",并且归档还被这个壳占着,挪不走。
// 外部脚本必须先于宿主退出、并且活在 Job 外面:先结束 GUI,再结束宿主,最后改名。

export function harnessRestartWave(proc, exe, installPids) {
  const name = String(proc?.name || "");
  const ep = String(proc?.executablePath || "").replace(/\//g, "\\");
  const cmd = String(proc?.commandLine || "").toLowerCase();
  const exeNorm = String(exe || "").replace(/\//g, "\\").toLowerCase();
  const epNorm = ep.toLowerCase();
  const root = exeNorm.replace(/\\[^\\]*$/, "");
  const nameLow = name.toLowerCase();
  const harnessName = nameLow === "deepseek harness.exe" || nameLow === "dsh desktop.exe";
  const under = Boolean(epNorm && (epNorm === exeNorm || (root && epNorm.startsWith(`${root}\\`))));
  if (cmd.includes("dsh-purge-official-restart") || cmd.includes("dsh-purge-asar-swap") || cmd.includes("dsh-purge-restart-desktop")) {
    return "skip";
  }
  if (!under && !harnessName) return "skip";
  const hostCmd = cmd.includes("electron_run_as_node") || cmd.includes("dsh-desktop-host");
  const parentIn = installPids instanceof Set && installPids.has(Number(proc?.parentProcessId));
  if (hostCmd || parentIn || !harnessName) return "after";
  return "gui";
}

/** Win32_Process.Create 的命令行。带空格的参数加引号,这样脚本路径可以有空格。 */
export function outsideJobCommandLine(file, args) {
  const quote = (value) => {
    const text = String(value ?? "");
    if (text.length === 0) return '""';
    if (!/[\s"&<>|^]/.test(text)) return text;
    return `"${text.replace(/"/g, '\\"')}"`;
  };
  return [file, ...(args || [])].map(quote).join(" ");
}

function spawnOutsideJob(file, args, label) {
  const commandLine = outsideJobCommandLine(file, args);
  logInternal(`restart spawn outside job (${label}): ${commandLine}`);
  const direct = () => {
    logInternal(`restart direct spawn (${label})`);
    const fallback = spawn(file, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    fallback.on("error", (err) => {
      logInternal(`restart direct spawn failed (${label}): ${err?.message || err}`);
    });
    fallback.unref();
    return fallback;
  };
  let child;
  try {
    child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command",
      "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:DSH_PURGE_SPAWN_CMD }; if (-not $r -or [int]$r.ReturnValue -ne 0) { Write-Output ('wmi ' + $(if ($r) { $r.ReturnValue } else { 'none' })); exit 1 }; Write-Output $r.ProcessId",
    ], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: { ...process.env, DSH_PURGE_SPAWN_CMD: commandLine },
    });
  } catch (err) {
    logInternal(`restart wmi launcher threw (${label}): ${err?.message || err}`);
    return direct();
  }
  let buf = "";
  let fellBack = false;
  const take = (chunk) => {
    buf += String(chunk || "");
    if (buf.length > 2000) buf = buf.slice(-2000);
  };
  const fallbackOnce = (why) => {
    if (fellBack) return;
    fellBack = true;
    logInternal(`restart wmi launcher fallback (${label}): ${why}`);
    direct();
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  child.on("error", (err) => fallbackOnce(err?.message || String(err)));
  child.on("close", (code) => {
    logInternal(`restart wmi launcher (${label}) exit ${code} ${buf.trim()}`);
    if (code !== 0) fallbackOnce(`exit ${code} ${buf.trim()}`);
  });
  child.unref();
  return child;
}

/** 密封包换 asar 时,Windows 不能让宿主自己 exit:旧壳还在就会弹 host stopped。 */
export function hostExitsDuringSealedSwap(platform = process.platform) {
  return platform !== "win32";
}

function spawnHelper(helper, payload, opts = {}) {
  const plan = restartPlan();
  const hinted = payload && payload.execPath ? payload.execPath : "";
  const execPath = hinted || plan.execPath;
  if (!execPath) throw new Error(plan.error || "未找到 DSH Desktop.exe，无法重启桌面应用");
  const child = spawn(process.execPath, [helper], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
    env: helperEnv({
      kind: "desktop",
      execPath,
      argv: plan.argv,
      cwd: plan.cwd || path.dirname(execPath),
      pid: process.pid,
      ...payload,
    }),
  });
  // 没挂 'error' 时,helper 路径不存在会变成 uncaughtException,宿主直接退出。
  child.on("error", (err) => {
    logInternal("spawn helper failed: " + (err && err.message ? err.message : err));
  });
  child.unref();
  if (opts.exit !== false) setTimeout(() => process.exit(0), opts.exitAfter ?? 250);
}

function desktopRuntimeOf(ctx) {
  if (!ctx || typeof ctx.get !== "function") return null;
  const runtime = ctx.get("desktopRuntime") || ctx.get("desktopActions");
  return runtime && typeof runtime.requestRestart === "function" ? runtime : null;
}

const ASAR_SWAP_PS1 = [
  "param(",
  "  [Parameter(Mandatory = $true)][int]$WaitPid,",
  "  [Parameter(Mandatory = $true)][string]$AsarPath,",
  "  [Parameter(Mandatory = $true)][string]$ExePath",
  ")",
  "$ErrorActionPreference = 'Continue'",
  "$installRoot = (Split-Path -Parent $ExePath).TrimEnd('\\')",
  "$exeNorm = $ExePath.ToLower()",
  "$desktopLog = Join-Path $env:TEMP 'dsh-purge-desktop.log'",
  "function Write-RestartLog([string]$Message) {",
  "  $line = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss') + ' [dsh-purge] restart ' + $Message",
  "  Add-Content -LiteralPath $desktopLog -Value $line -Encoding ascii -ErrorAction SilentlyContinue",
  "}",
  "Write-RestartLog \"powershell begin waitPid=$WaitPid asar=$AsarPath\"",
  "function Test-HelperCmd([string]$cmd) {",
  "  if (-not $cmd) { return $false }",
  "  $c = $cmd.ToLower()",
  "  return $c.Contains('dsh-purge-official-restart') -or $c.Contains('dsh-purge-asar-swap') -or $c.Contains('dsh-purge-restart-desktop')",
  "}",
  "function Test-HostCmd([string]$cmd) {",
  "  if (-not $cmd) { return $false }",
  "  if (Test-HelperCmd $cmd) { return $false }",
  "  $c = $cmd.ToLower()",
  "  return $c.Contains('electron_run_as_node') -or $c.Contains('dsh-desktop-host')",
  "}",
  "function Test-HarnessName([string]$name) {",
  "  return $name -eq 'DeepSeek Harness.exe' -or $name -eq 'DSH Desktop.exe'",
  "}",
  "function Test-UnderInstall([string]$ep) {",
  "  if (-not $ep) { return $false }",
  "  $low = $ep.ToLower()",
  "  if ($low -eq $exeNorm) { return $true }",
  "  return $low.StartsWith($installRoot.ToLower() + '\\')",
  "}",
  "function Get-InstallProcs {",
  "  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
  "    (Test-UnderInstall $_.ExecutablePath) -or (Test-HarnessName $_.Name)",
  "  })",
  "}",
  "function Split-RestartWaves($procs) {",
  "  $ids = @{}",
  "  foreach ($p in @($procs)) { $ids[[int]$p.ProcessId] = $true }",
  "  $gui = New-Object System.Collections.Generic.List[int]",
  "  $after = New-Object System.Collections.Generic.List[int]",
  "  foreach ($p in @($procs)) {",
  "    $cmd = [string]$p.CommandLine",
  "    if (Test-HelperCmd $cmd) { continue }",
  "    $procId = [int]$p.ProcessId",
  "    if ($procId -eq $PID) { continue }",
  "    $parentIn = $ids.ContainsKey([int]$p.ParentProcessId)",
  "    if ((Test-HostCmd $cmd) -or $parentIn -or -not (Test-HarnessName ([string]$p.Name))) {",
  "      [void]$after.Add($procId)",
  "    } else {",
  "      [void]$gui.Add($procId)",
  "    }",
  "  }",
  "  return @{ gui = @($gui); after = @($after) }",
  "}",
  "function Stop-PidList($ids) {",
  "  foreach ($procId in @($ids)) {",
  "    if (-not $procId -or $procId -eq $PID) { continue }",
  "    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue",
  "  }",
  "}",
  "function Wait-PidListGone($ids, $seconds) {",
  "  $deadline = (Get-Date).AddSeconds($seconds)",
  "  do {",
  "    $alive = @($ids | Where-Object { $_ -and (Get-Process -Id $_ -ErrorAction SilentlyContinue) })",
  "    if ($alive.Count -eq 0) { return $true }",
  "    Start-Sleep -Milliseconds 200",
  "  } while ((Get-Date) -lt $deadline)",
  "  return $false",
  "}",
  "function Stop-Remaining {",
  "  $left = Split-RestartWaves (Get-InstallProcs)",
  "  $rest = @($left.gui + $left.after)",
  "  Write-RestartLog ('kill host ' + ($rest -join ','))",
  "  Stop-PidList $rest",
  "  Wait-PidListGone $rest 10 | Out-Null",
  "}",
  "$first = Split-RestartWaves (Get-InstallProcs)",
  "Write-RestartLog ('kill gui ' + ($first.gui -join ','))",
  "Stop-PidList $first.gui",
  "Wait-PidListGone $first.gui 15 | Out-Null",
  "Write-RestartLog 'gui gone'",
  "Stop-Remaining",
  "Write-RestartLog 'processes gone'",
  "Start-Sleep -Milliseconds 400",
  "$appDir = Join-Path (Split-Path -Parent $AsarPath) 'app'",
  "$unpacked = $AsarPath + '.unpacked'",
  "$marker = Join-Path $appDir 'dsh\\node_modules\\node-addon-require-builtin-win32-x64-msvc\\prebuilt\\win32-x64-msvc-napi-v9.node'",
  "if ((Test-Path -LiteralPath $unpacked) -and -not (Test-Path -LiteralPath $marker)) {",
  "  & robocopy.exe $unpacked $appDir /E /XC /XN /XO /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null",
  "}",
  "$moved = -not (Test-Path -LiteralPath $AsarPath)",
  "if (Test-Path -LiteralPath $AsarPath) {",
  "  $bak = \"$AsarPath.bak\"",
  "  if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue }",
  "  for ($i = 0; $i -lt 80; $i++) {",
  "    try {",
  "      Move-Item -LiteralPath $AsarPath -Destination $bak -Force",
  "      $moved = $true",
  "      break",
  "    } catch {",
  "      Write-RestartLog ('rename attempt ' + $i + ' ' + $_.Exception.Message)",
  "      if ($i -eq 20 -or $i -eq 50) { Stop-Remaining; Start-Sleep -Seconds 1 }",
  "      Start-Sleep -Milliseconds 400",
  "    }",
  "  }",
  "}",
  "$lock = $AsarPath + '.rename-pending'",
  "if ($moved) {",
  "  Write-RestartLog 'renamed'",
  "  Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue",
  "  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue",
  "  Start-Process -FilePath $ExePath",
  "  Write-RestartLog 'started'",
  "} else {",
  "  Write-RestartLog 'rename failed'",
  "  Set-Content -LiteralPath $lock -Value ((Get-Date).ToString('o')) -Encoding ascii",
  "}",
  "",
].join("\r\n");

const ASAR_RENAME_WHEN_IDLE_PS1 = [
  "param(",
  "  [Parameter(Mandatory = $true)][string]$AsarPath,",
  "  [Parameter(Mandatory = $true)][string]$ExePath,",
  "  [Parameter(Mandatory = $true)][string]$LockPath",
  ")",
  "$ErrorActionPreference = 'Continue'",
  "$deadline = (Get-Date).AddMinutes(30)",
  "while ((Get-Date) -lt $deadline) {",
  "  $restartFlag = Join-Path $env:TEMP 'dsh-purge-official-restarting'",
  "  if (Test-Path -LiteralPath $restartFlag) {",
  "    $flagAge = (Get-Date) - (Get-Item -LiteralPath $restartFlag).LastWriteTime",
  "    if ($flagAge.TotalSeconds -ge 0 -and $flagAge.TotalSeconds -lt 45) { exit 0 }",
  "    Remove-Item -LiteralPath $restartFlag -Force -ErrorAction SilentlyContinue",
  "  }",
  "  $holding = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq $ExePath } catch { $false } })",
  "  if ($holding.Count -gt 0) { Start-Sleep -Milliseconds 500; continue }",
  "  if (-not (Test-Path -LiteralPath $AsarPath)) {",
  "    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue",
  "    exit 0",
  "  }",
  "  $appDir = Join-Path (Split-Path -Parent $AsarPath) 'app'",
  "  $unpacked = $AsarPath + '.unpacked'",
  "  $marker = Join-Path $appDir 'dsh\\node_modules\\node-addon-require-builtin-win32-x64-msvc\\prebuilt\\win32-x64-msvc-napi-v9.node'",
  "  if ((Test-Path -LiteralPath $unpacked) -and -not (Test-Path -LiteralPath $marker)) {",
  "    & robocopy.exe $unpacked $appDir /E /XC /XN /XO /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null",
  "  }",
  "  $bak = \"$AsarPath.bak\"",
  "  if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue }",
  "  try {",
  "    Move-Item -LiteralPath $AsarPath -Destination $bak -Force -ErrorAction Stop",
  "  } catch {",
  "    Start-Sleep -Milliseconds 400",
  "    continue",
  "  }",
  "  Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue",
  "  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue",
  "  Start-Process -FilePath $ExePath",
  "  exit 0",
  "}",
  "Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue",
  "",
].join("\r\n");

const ASAR_RENAME_WHEN_IDLE_SH = [
  "#!/bin/sh",
  "asar=$1",
  "exe=$2",
  "lock=$3",
  "deadline=$(($(date +%s) + 1800))",
  "relaunch() {",
  "  unset ELECTRON_RUN_AS_NODE",
  "  case \"$(uname -s)\" in",
  "    Darwin)",
  "      case \"$exe\" in",
  "        */Contents/MacOS/*)",
  "          bundle=$(dirname \"$(dirname \"$(dirname \"$exe\")\")\")",
  "          open \"$bundle\"",
  "          return",
  "          ;;",
  "      esac",
  "      ;;",
  "  esac",
  "  nohup \"$exe\" >/dev/null 2>&1 &",
  "}",
  "app_running() {",
  "  ps -Ao command= 2>/dev/null | grep -F \"$exe\" | grep -v \"dsh-purge-asar-rename-when-idle\" | grep -v grep >/dev/null",
  "}",
  "while [ \"$(date +%s)\" -lt \"$deadline\" ]; do",
  "  if [ ! -e \"$asar\" ]; then",
  "    rm -f \"$lock\"",
  "    exit 0",
  "  fi",
  "  if app_running; then",
  "    sleep 1",
  "    continue",
  "  fi",
  "  bak=\"$asar.bak\"",
  "  rm -f \"$bak\"",
  "  if mv \"$asar\" \"$bak\" 2>/dev/null; then",
  "    rm -f \"$lock\"",
  "    relaunch",
  "    exit 0",
  "  fi",
  "  sleep 1",
  "done",
  "rm -f \"$lock\"",
  "exit 1",
  "",
].join("\n");

/** 官方壳开着时 app.asar 被占用。不结束进程，等用户退出后再改名并重新打开。 */
export function scheduleAsarRenameWhenIdle({ exe, asar } = {}) {
  if (!exe || !asar) return { pending: false };
  const lock = `${asar}.rename-pending`;
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age >= 0 && age < 30 * 60 * 1000) return { pending: true, already: true };
    // age<0 时钟回拨或 age>=30min stale，视为失效，清掉重做。
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  } catch {
    // 没有待处理标记，下面新建。
  }
  fs.writeFileSync(lock, `${Date.now()}\n`, "utf8");
  if (process.platform === "win32") {
    const script = path.join(os.tmpdir(), `dsh-purge-asar-rename-when-idle-${restartUniqSuffix()}.ps1`);
    fs.writeFileSync(script, ASAR_RENAME_WHEN_IDLE_PS1, "utf8");
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-AsarPath",
        asar,
        "-ExePath",
        exe,
        "-LockPath",
        lock,
      ],
      { detached: true, stdio: "ignore", windowsHide: true, shell: false },
    );
    // detached spawn 的 ENOENT / 权限错误走 'error' 事件,没监听会 uncaught → 整个进程崩。
    child.on("error", (err) => {
      try { console.warn("[dsh-purge] asar rename idle PS1 spawn 失败:", err?.message || err); } catch { /* 忽略 */ }
    });
    child.unref();
    return { pending: true };
  }
  const script = path.join(os.tmpdir(), `dsh-purge-asar-rename-when-idle-${restartUniqSuffix()}.sh`);
  fs.writeFileSync(script, ASAR_RENAME_WHEN_IDLE_SH, { encoding: "utf8", mode: 0o755 });
  const child = spawn("/bin/sh", [script, asar, exe, lock], {
    detached: true,
    stdio: "ignore",
    shell: false,
  });
  child.on("error", (err) => {
    try { console.warn("[dsh-purge] asar rename idle sh spawn 失败:", err?.message || err); } catch { /* 忽略 */ }
  });
  child.unref();
  return { pending: true };
}

/** 等当前桌面进程退出后把 app.asar 挪走，再启动 exe。解开后的 resources/app 才会被加载。 */
export function scheduleAsarSwapRestart({ exe, asar, waitPid = process.pid, exit = false, runtime = null, ctx = null } = {}) {
  if (!exe || !asar) throw new Error("缺少桌面 exe 或 app.asar，无法重启");
  // 若调用方没显式传 runtime,但传了 ctx —— 自己解析一次。
  // 让启动期自愈路径 (index.js:scheduleApplyRestart / 2004 自愈分支) 透传 ctx 就能走优雅握手。
  if (!runtime && ctx) {
    try { runtime = desktopRuntimeOf(ctx); } catch { /* ignore */ }
  }
  // 密封 Windows 壳仍是 app.asar 里的旧 close 回调。宿主 process.exit(0) 会变成
  // "dsh desktop host stopped",对话框还占着 app.asar,后面的改名全部失败。
  // Windows 上外部脚本先结束 GUI,再结束宿主。其它平台仍由宿主自己退出。
  const gracefulExit = () => {
    if (!hostExitsDuringSealedSwap()) {
      logInternal("asar swap: windows host stays up until the GUI is gone");
      return;
    }
    if (!runtime) {
      logInternal("asar swap: no runtime handoff, host will exit after the helper starts");
      setTimeout(() => { try { process.exit(0); } catch {} }, 1500);
      return;
    }
    logInternal("asar swap: handing off restart to desktopRuntime");
    try {
      Promise.resolve(runtime.requestRestart()).catch((err) => {
        logInternal("desktopRuntime.requestRestart rejected: " + (err?.message || err));
      });
    } catch (err) {
      logInternal("desktopRuntime.requestRestart threw: " + (err?.message || err));
    }
    setTimeout(() => {
      try { process.exit(0); } catch {}
    }, 2000);
  };

  if (sealedSwapKind() === "helper") {
    const helper = fileURLToPath(new URL("./restart-desktop.js", import.meta.url));
    spawnHelper(helper, {
      respawn: true,
      killApp: true,
      asar,
      execPath: exe,
      cwd: path.dirname(exe),
      waitPid,
    }, { exit: false });
    if (exit !== false) gracefulExit();
    return { scheduled: true };
  }
  const script = path.join(os.tmpdir(), `dsh-purge-asar-swap-${process.pid}.ps1`);
  fs.writeFileSync(script, ASAR_SWAP_PS1, "utf8");
  logInternal(`asar swap: powershell script ${script} asar=${asar} exe=${exe} waitPid=${waitPid}`);
  spawnOutsideJob("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", script,
    "-WaitPid", String(waitPid),
    "-AsarPath", asar,
    "-ExePath", exe,
  ], "powershell-asar-swap");
  if (exit !== false) gracefulExit();
  return { scheduled: true };
}

export function asarSwapPowerShell() {
  return ASAR_SWAP_PS1;
}

/**
 * 点「应用」之后走哪条重启。#64：宿主 requestRestart 在桌面端会空返回，进程不动。
 * Windows 官方包用 wscript 结束再打开。Linux / macOS 能定位到 exe 就走 restart-desktop.js。
 */
export function desktopRestartChoice(input = {}) {
  const platform = input.platform || process.platform;
  const exe = input.exe || "";
  const desktopExe = Boolean(exe && isDesktopExecutable(exe));
  const official = Boolean(exe && isOfficialHarnessExecutable(exe));
  if (input.openBrowser === false) return "skip";
  if (platform === "win32" && official) return "windows-official";
  if (desktopExe && input.asarSealed === true) return "asar-swap";
  if (desktopExe) return "helper";
  if (input.hasRuntime) return "request-restart";
  return "helper";
}

/** 密封 asar 要先退出进程才能挪走文件。Windows 用 PowerShell；Linux / macOS 用同一份重启脚本。 */
export function sealedSwapKind(platform = process.platform) {
  return platform === "win32" ? "powershell" : "helper";
}

function officialExeFromProcess() {
  if (isOfficialHarnessExecutable(process.execPath) && isFile(process.execPath)) {
    return path.normalize(process.execPath);
  }
  const resources = process.resourcesPath;
  if (!resources) return "";
  const hit = firstExistingExe([path.dirname(path.normalize(resources))]);
  if (hit && isOfficialHarnessExecutable(hit)) return hit;
  return "";
}

function dshHomeForRelaunch() {
  const current = String(process.env.DSH_HOME || "").replace(/[\\/]+$/, "");
  if (!current) return "";
  if (current.toLowerCase().endsWith(".dsh")) return current;
  const nested = path.join(current, ".dsh");
  try {
    if (fs.existsSync(path.join(nested, "profiles"))) return nested;
  } catch {
    // 用当前值。
  }
  return current;
}

export function scheduleRestart(request, ctx, options = {}) {
  // 启动自检会带 openBrowser:false。桌面进程不再因此杀掉自己。
  if (options.openBrowser === false) return { restarting: false, skipped: true };
  const exe =
    officialExeFromProcess() ||
    findDesktopAppExecutable() ||
    "";
  const asar = exe ? appAsarPath(exe) : "";
  // ctx 透传给 restartOfficialHarness → scheduleAsarSwapRestart,让 PowerShell 分支
  // 拿到 desktopRuntime 走 requestRestart 优雅退出,避免宿主误报 crash。
  if (process.platform === "win32" && exe && isOfficialHarnessExecutable(exe)) {
    return restartOfficialHarness({ exe, asar, ctx });
  }
  if (exe && asar && asarArchiveIsFile(asar)) {
    const runtime = desktopRuntimeOf(ctx);
    scheduleAsarSwapRestart({ exe, asar, waitPid: process.pid, exit: true, runtime });
    return { restarting: true, asarSwap: true };
  }
  const runtime = desktopRuntimeOf(ctx);
  const choice = desktopRestartChoice({
    exe,
    asarSealed: false,
    hasRuntime: Boolean(runtime),
  });
  if (choice === "helper" && exe && isDesktopExecutable(exe)) {
    const helper = fileURLToPath(new URL("./restart-desktop.js", import.meta.url));
    try {
      spawnHelper(helper, {
        respawn: true,
        killApp: true,
        execPath: exe,
        cwd: path.dirname(exe),
      }, { exit: false });
    } catch (error) {
      return {
        restarting: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return { restarting: true };
  }
  if (runtime) {
    // 只走桌面整应用 relaunch，不要 exit Host（那会先把内嵌 web 单独拉起来）。
    Promise.resolve(runtime.requestRestart()).catch((err) => {
      logInternal("desktop requestRestart failed: " + (err?.message || err));
    });
    return { restarting: true };
  }
  const helper = fileURLToPath(new URL("./restart-desktop.js", import.meta.url));
  spawnHelper(helper, { respawn: true, killApp: true }, { exit: false });
  return { restarting: true };
}

function jsString(value) {
  return wshLiteral(value);
}

export function officialRestartScript(exe, asar, dshHome) {
  const log = path.join(os.tmpdir(), "dsh-purge-official-restart.log");
  return [
    "var exe = " + jsString(exe) + ";",
    "var asar = " + jsString(asar) + ";",
    "var home = " + jsString(dshHome || "") + ";",
    "var logPath = " + jsString(log) + ";",
    "var desktopLog = " + jsString(path.join(os.tmpdir(), "dsh-purge-desktop.log")) + ";",
    "var fso = new ActiveXObject('Scripting.FileSystemObject');",
    "var sh = new ActiveXObject('WScript.Shell');",
    "var wmi = GetObject('winmgmts:\\\\\\\\.\\\\root\\\\cimv2');",
    "function z(n) { return (n < 10 ? '0' : '') + n; }",
    "function stamp() { var d = new Date(); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + 'T' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds()); }",
    "function log(m) { var line = stamp() + ' [dsh-purge] restart ' + m; try { var f = fso.OpenTextFile(logPath, 8, true); f.WriteLine(line); f.Close(); } catch (ignoreA) {} try { var g = fso.OpenTextFile(desktopLog, 8, true); g.WriteLine(line); g.Close(); } catch (ignoreB) {} }",
    "function installRoot() { return fso.GetParentFolderName(exe); }",
    "function isHarnessName(name) { var n = String(name || '').toLowerCase(); return n === 'deepseek harness.exe' || n === 'dsh desktop.exe'; }",
    "function isHelperCmd(cmd) { var c = String(cmd || '').toLowerCase(); return c.indexOf('dsh-purge-official-restart') >= 0 || c.indexOf('dsh-purge-asar-swap') >= 0 || c.indexOf('dsh-purge-restart-desktop') >= 0; }",
    "function isHostCmd(cmd) { var c = String(cmd || '').toLowerCase(); if (isHelperCmd(c)) return false; return c.indexOf('electron_run_as_node') >= 0 || c.indexOf('dsh-desktop-host') >= 0; }",
    "function underInstall(ep) { var low = String(ep || '').replace(/\\//g, '\\\\').toLowerCase(); if (!low) return false; var exeLow = String(exe || '').replace(/\\//g, '\\\\').toLowerCase(); if (low === exeLow) return true; var root = String(installRoot() || '').replace(/\\//g, '\\\\').toLowerCase(); return !!(root && low.indexOf(root + '\\\\') === 0); }",
    "function listProcs() { var out = []; var queries = ['SELECT ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine FROM Win32_Process', 'SELECT ProcessId, ParentProcessId, Name, ExecutablePath FROM Win32_Process']; for (var q = 0; q < queries.length; q++) { try { var e = new Enumerator(wmi.ExecQuery(queries[q])); for (; !e.atEnd(); e.moveNext()) { try { var p = e.item(); if (underInstall(p.ExecutablePath) || isHarnessName(p.Name)) out.push(p); } catch (ignoreItem) {} } return out; } catch (ignoreQuery) {} } log('proc query failed'); return out; }",
    "function splitWaves(list) { var ids = {}; var kept = []; for (var i = 0; i < list.length; i++) { var p = list[i]; var cmd = ''; try { cmd = String(p.CommandLine || ''); } catch (ignoreCmd) {} if (isHelperCmd(cmd)) continue; ids[p.ProcessId] = true; kept.push({ pid: p.ProcessId, cmd: cmd, name: String(p.Name || ''), parent: p.ParentProcessId }); } var gui = []; var after = []; for (var j = 0; j < kept.length; j++) { var row = kept[j]; var parentIn = ids[row.parent] === true; if (isHostCmd(row.cmd) || parentIn || !isHarnessName(row.name)) after.push(row.pid); else gui.push(row.pid); } return { gui: gui, after: after }; }",
    "function killPids(list) { for (var i = 0; i < list.length; i++) { if (!list[i]) continue; sh.Run('taskkill.exe /F /PID ' + list[i], 0, true); } }",
    "function aliveIds(want) { var now = listProcs(); var have = {}; for (var i = 0; i < now.length; i++) have[now[i].ProcessId] = true; var left = []; for (var j = 0; j < want.length; j++) if (have[want[j]]) left.push(want[j]); return left; }",
    "function waitGone(list, ms) { var deadline = new Date().getTime() + ms; while (new Date().getTime() < deadline) { if (aliveIds(list).length === 0) return true; WScript.Sleep(200); } return aliveIds(list).length === 0; }",
    "function killAfterGui() { var again = splitWaves(listProcs()); var rest = again.gui.concat(again.after); log('kill host ' + rest.join(',')); killPids(rest); waitGone(rest, 10000); }",
    "log('begin');",
    "var promptFile = asar.replace(/app\\.asar$/i, 'app') + '\\\\dsh\\\\node_modules\\\\@deepseek-ai\\\\dsh-system-prompt\\\\lib\\\\index.js';",
    "var altFile = asar.replace(/app\\.asar$/i, 'app') + '\\\\node_modules\\\\@deepseek-ai\\\\dsh-system-prompt\\\\lib\\\\index.js';",
    "function readBody(file) { if (!fso.FileExists(file)) return ''; var tf = fso.OpenTextFile(file, 1); var body = tf.ReadAll(); tf.Close(); return body; }",
    "function hostClean(body) { if (!body) return null; var ident = body.indexOf('[dsh-purge] identity stripped') >= 0; var kept = body.indexOf('[dsh-purge] complete prompt keeps waterfall inject') >= 0 || body.indexOf('[dsh-purge] complete prompt keeps inject') >= 0; if (ident && kept) return true; if (body.indexOf('system-prompt/assemble') < 0) return false; var identityLeft = body.indexOf('You are an AI agent powered by DeepSeek Harness.') >= 0; var drops = body.indexOf('transformed.sections : [completeSection]') >= 0; return !identityLeft && !drops; }",
    "var clean = false;",
    "var primary = hostClean(readBody(promptFile));",
    "var alt = hostClean(readBody(altFile));",
    "// null means the file is missing. Only an explicit false blocks the relaunch.",
    "clean = primary != false && alt != false;",
    "if (!clean) { log('clean markers missing; not starting'); try { if (fso.FileExists(" + jsString(path.join(os.tmpdir(), "dsh-purge-official-restarting")) + ")) fso.DeleteFile(" + jsString(path.join(os.tmpdir(), "dsh-purge-official-restarting")) + ", true); } catch (ignoreStop) {} WScript.Quit(1); }",
    "if (clean) {",
    "log('clean markers ok');",
    "var waves = splitWaves(listProcs());",
    "log('kill gui ' + waves.gui.join(','));",
    "killPids(waves.gui);",
    "waitGone(waves.gui, 15000);",
    "log('gui gone');",
    "killAfterGui();",
    "log('processes gone');",
    "WScript.Sleep(400);",
    "var unpacked = asar + '.unpacked';",
    "var appDir = asar.replace(/app\\.asar$/i, 'app');",
    "var marker = appDir + '\\\\dsh\\\\node_modules\\\\node-addon-require-builtin-win32-x64-msvc\\\\prebuilt\\\\win32-x64-msvc-napi-v9.node';",
    "if (fso.FolderExists(unpacked) && !fso.FileExists(marker)) { sh.Run('robocopy.exe \"' + unpacked + '\" \"' + appDir + '\" /E /XC /XN /XO /NFL /NDL /NJH /NJS /nc /ns /np', 0, true); log('overlay'); }",
    "var renamed = false;",
    "if (!fso.FileExists(asar)) { renamed = true; log('asar already absent'); }",
    "if (fso.FileExists(asar)) { var bak = asar + '.bak'; if (fso.FileExists(bak)) fso.DeleteFile(bak, true); for (var n = 0; n < 80; n++) { try { fso.MoveFile(asar, bak); renamed = true; log('renamed'); break; } catch (err) { log('rename attempt ' + n + ' ' + (err && err.message ? err.message : String(err))); if (n === 20 || n === 50) { killAfterGui(); WScript.Sleep(800); } WScript.Sleep(300); } } }",
    "if (!renamed) { log('rename failed; not starting'); try { if (fso.FileExists(" + jsString(path.join(os.tmpdir(), "dsh-purge-official-restarting")) + ")) fso.DeleteFile(" + jsString(path.join(os.tmpdir(), "dsh-purge-official-restarting")) + ", true); } catch (ignoreStop2) {} WScript.Quit(1); }",
    "if (renamed) {",
    "try { sh.Environment('PROCESS').Remove('ELECTRON_RUN_AS_NODE'); } catch (ignore) {}",
    "try { sh.Environment('PROCESS').Remove('DSH_BASE'); } catch (ignoreBase) {}",
    "if (home) { try { sh.Environment('PROCESS').Item('DSH_HOME') = home; } catch (ignore2) {} }",
    "sh.Run('\"' + exe + '\"', 1, false);",
    "log('started');",
    "}",
    "}",
    // Keep the inflight window just long enough to cover a cold client start;
    // the original 180s left the panel unresponsive for 3 minutes after every restart.
    "WScript.Sleep(45000);",
    "try { if (fso.FileExists(" + jsString(path.join(os.tmpdir(), "dsh-purge-official-restarting")) + ")) fso.DeleteFile(" + jsString(path.join(os.tmpdir(), "dsh-purge-official-restarting")) + ", true); } catch (ignoreFlag) {}",
    "",
  ].join("\r\n");
}

function systemPromptFiles(exe) {
  const appDir = appDirForExecutable(exe);
  if (!appDir) return [];
  return [
    path.join(appDir, "dsh", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js"),
    path.join(appDir, "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js"),
  ].filter((fp) => {
    try { return fs.existsSync(fp); } catch { return false; }
  });
}

function unpackedHostIsClean(exe) {
  const files = systemPromptFiles(exe);
  if (files.length === 0) return false;
  return files.every((fp) => {
    try {
      return hostPromptKeepsInject(fs.readFileSync(fp, "utf8"));
    } catch {
      return false;
    }
  });
}

const OFFICIAL_RESTART_FLAG = "dsh-purge-official-restarting";
const OFFICIAL_RESTART_WINDOW_MS = 45000;

/**
 * Windows 官方换包走哪条。
 * 本机 wscript 能跑 .js 时仍用原来的脚本。跑不了（云端很多机器没有 JScript 引擎）
 * 才改用已经在用的 PowerShell。没确认脚本已经开始，不把进行中的标记当成成功。
 */
export function planOfficialRestart({ wshJs, scriptAscii, inflightAgeMs, logStarted, logState } = {}) {
  const age = Number(inflightAgeMs);
  const fresh = Number.isFinite(age) && age >= 0 && age < OFFICIAL_RESTART_WINDOW_MS;
  const state = logState || (logStarted === true ? "running" : "none");
  // 只有脚本正在结束当前进程时才算进行中。写过 begin 又停掉的，这次点击要重新开始。
  if (fresh && state === "running") return { action: "already" };
  const kind = wshJs === true && scriptAscii !== false ? "wscript" : "powershell";
  return {
    action: "start",
    kind,
    writeInflight: kind === "wscript",
    clearInflight: kind !== "wscript",
  };
}

function officialRestartFlagPath() {
  return path.join(os.tmpdir(), OFFICIAL_RESTART_FLAG);
}

function officialRestartLogState(sinceMs) {
  try {
    const log = path.join(os.tmpdir(), "dsh-purge-official-restart.log");
    const st = fs.statSync(log);
    if (sinceMs && st.mtimeMs + 1000 < sinceMs) return "none";
    const lines = fs.readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean);
    let begin = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/(^|\s)begin$/.test(lines[i])) begin = i;
    }
    if (begin < 0) return "none";
    const tail = lines.slice(begin);
    if (tail.some((line) => /not starting|rename failed/.test(line))) return "aborted";
    if (tail.some((line) => /(^|\s)started$/.test(line))) return "done";
    return "running";
  } catch {
    return "none";
  }
}

let wshJsEngineCached;
function wshJsEngineWorks() {
  if (wshJsEngineCached !== undefined) return wshJsEngineCached;
  wshJsEngineCached = probeWshJsEngine();
  return wshJsEngineCached;
}

function probeWshJsEngine() {
  const id = `${process.pid}-${Date.now()}`;
  const script = path.join(os.tmpdir(), `dsh-purge-wsh-probe-${id}.js`);
  const out = path.join(os.tmpdir(), `dsh-purge-wsh-probe-${id}.txt`);
  try {
    const body = "var fso=new ActiveXObject('Scripting.FileSystemObject');var f=fso.CreateTextFile("
      + wshLiteral(out)
      + ", true);f.WriteLine('ok');f.Close();\r\n";
    fs.writeFileSync(script, body, "utf8");
    execFileSync("cscript.exe", ["//nologo", script], {
      timeout: 4000,
      windowsHide: true,
      stdio: "ignore",
    });
    return fs.existsSync(out);
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(script); } catch { /* 探针用完即删 */ }
    try { fs.unlinkSync(out); } catch { /* 探针用完即删 */ }
  }
}

/** 点「重启」后结束当前官方客户端，挪开被占用的 app.asar，再自己打开。 */
export function restartOfficialHarness(options = {}) {
  const hinted = options.exe ? path.normalize(String(options.exe)) : "";
  const exe =
    (hinted && isDesktopExecutable(hinted) ? hinted : "") ||
    officialExeFromProcess() ||
    findDesktopAppExecutable() ||
    "";
  if (!exe) return { restarting: false };
  // ctx 可用时 → 拿 desktopRuntime 透传给 PowerShell 分支:
  // 让宿主 ack 预期的 restart,避免 host 退出被当成 crash 弹对话框。
  const runtime = options.runtime || (options.ctx ? desktopRuntimeOf(options.ctx) : null);
  if (!isOfficialHarnessExecutable(exe)) {
    const asar = options.asar || appAsarPath(exe);
    if (asar && asarArchiveIsFile(asar)) {
      scheduleAsarSwapRestart({
        exe,
        asar,
        waitPid: process.pid,
        exit: options.exit !== false,
        runtime,
      });
      return { restarting: true, asarSwap: true };
    }
    return { restarting: false };
  }
  // #57：不自动跑官方 installer。宿主版本百花齐放，更新交接由用户自己做；
  // 插件只负责解包/补丁。旧逻辑会在落盘前误判失败并清掉 resources\app。
  if (options.requireClean !== false && !unpackedHostIsClean(exe)) {
    return { restarting: false, clean: false };
  }
  const inflight = officialRestartFlagPath();
  let inflightAgeMs = -1;
  let inflightMtime = 0;
  try {
    const st = fs.statSync(inflight);
    inflightAgeMs = Date.now() - st.mtimeMs;
    inflightMtime = st.mtimeMs;
  } catch {
    // 没有进行中的重启。
  }
  const asar = options.asar || appAsarPath(exe);
  const restartBody = officialRestartScript(exe, asar, dshHomeForRelaunch());
  const scriptAscii = isWshAscii(restartBody);
  const plan = planOfficialRestart({
    wshJs: scriptAscii && wshJsEngineWorks(),
    scriptAscii,
    inflightAgeMs,
    logState: officialRestartLogState(inflightMtime),
  });
  logInternal(`official restart plan ${plan.action} kind=${plan.kind} ascii=${scriptAscii} exe=${exe} asar=${asar || ""}`);
  if (plan.action === "already") return { restarting: true, already: true };
  if (plan.clearInflight) {
    try { fs.unlinkSync(inflight); } catch { /* 没有残留标记 */ }
  }
  if (plan.kind === "powershell") {
    // [dsh-purge-fix 2026-10-09] asar 已被挪走(unpacked 模式常态):
    // ASAR_SWAP_PS1 fs.rename asar 会 ENOENT, 返 restarting:false 时 UI 显示
    // "失败: not started"。改走 helper restart-desktop.js:它的 moveAsarAsideAsync
    // 本身就处理 asar=null(第 283 行 fs.existsSync 不存在直接 return true),
    // relaunchDesktop 走 execPath spawn,干净 kill+relaunch,无 asar swap。
    if (!asar || !asarArchiveIsFile(asar)) {
      logInternal("asar 已不存在(unpacked 模式),改走 helper kill+relaunch");
      try {
        const helper = fileURLToPath(new URL("./restart-desktop.js", import.meta.url));
        spawnHelper(helper, {
          respawn: true,
          killApp: true,
          asar: null,
          execPath: exe,
          cwd: path.dirname(exe),
          waitPid: process.pid,
        }, { exit: options.exit !== false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logInternal("unpacked helper restart failed: " + message);
        return { restarting: false, error: message };
      }
      return { restarting: true, mode: "unpacked-helper", engine: "helper" };
    }
    logInternal("wscript 不能执行 .js，改用 PowerShell 挪开 app.asar");
    try {
      scheduleAsarSwapRestart({
        exe,
        asar,
        waitPid: process.pid,
        exit: options.exit !== false,
        runtime,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logInternal("PowerShell asar swap failed: " + message);
      return { restarting: false, error: message };
    }
    return { restarting: true, asarSwap: true, engine: "powershell" };
  }
  if (plan.writeInflight) {
    try { fs.writeFileSync(inflight, `${Date.now()}\n`, "utf8"); } catch { /* 标记写失败仍继续这一次 */ }
  }
  const asarPresent = Boolean(asar && asarArchiveIsFile(asar));
  const swapLock = asar ? `${asar}.swap-lock` : "";
  if (asarPresent && swapLock) {
    try {
      const lockStat = fs.statSync(swapLock);
      const age = Date.now() - lockStat.mtimeMs;
      // 锁还在、但重启日志没有 begin：上一轮 wscript 没跑起来，不能把它当成正在换包。
      if (age >= 0 && age < 90 * 1000 && officialRestartLogState(lockStat.mtimeMs) === "running") {
        return { restarting: true, already: true, asarSwap: true };
      }
    } catch {
      // 没有进行中的切换。
    }
    try { fs.writeFileSync(swapLock, `${Date.now()}\n`, "utf8"); } catch {}
  }
  // 启动时清一次残留的旧 restart 脚本/日志。多实例时，脚本名用 pid+random 避免打架。
  cleanupLegacyRestartScripts();
  const script = path.join(os.tmpdir(), `dsh-purge-official-restart-${restartUniqSuffix()}.js`);
  fs.writeFileSync(script, restartBody, "utf8");
  // 直接起 wscript.exe；不写 .cmd 中介文件，避免路径有空格/引号时解析异常。
  logInternal(`official restart: wscript outside job script=${script} asar=${asar} exe=${exe}`);
  spawnOutsideJob("wscript.exe", ["//nologo", "//B", script], "wscript");
  return { restarting: true, engine: "wscript" };
}

export function scheduleCleanupRestart({ cleanup = [], ctx } = {}) {
  const src = fileURLToPath(new URL("./restart-desktop.js", import.meta.url));
  const dest = path.join(os.tmpdir(), `dsh-purge-uninst-${process.pid}.mjs`);
  fs.copyFileSync(src, dest);
  const runtime = desktopRuntimeOf(ctx);
  if (runtime) {
    spawnHelper(dest, { cleanup, helper: dest, respawn: false }, { exit: false });
    Promise.resolve(runtime.requestRestart()).catch((err) => {
      logInternal("desktop uninstall restart failed: " + (err?.message || err));
    });
    return { restarting: true };
  }
  spawnHelper(dest, { cleanup, helper: dest, respawn: true, killApp: true }, { exit: false });
  return { restarting: true };
}

const CLI_ENTRY_BEGIN = "# dsh-purge cli entry begin";
const CLI_ENTRY_END = "# dsh-purge cli entry end";
const CLI_ASAR_ENTRY = "app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js";
// #94:官方桌面版把 dsh host 放在 app.asar.unpacked(见 isAiBase 的 app.asar.unpacked 分支),
// 不在封装的 app.asar 里。stock 启动脚本却写死 app.asar/.../cli.js → Cannot find module。
// 回退链必须是 app.asar → app.asar.unpacked → app/,少了中间这级 macOS 开箱即坏。
const CLI_UNPACKED_ENTRY = "app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js";
const CLI_DIR_ENTRY = "app/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js";

function ensureAppRuntimeSymlink(resources) {
  const appDir = path.join(resources, "app");
  const runtime = path.join(resources, "runtime");
  const link = path.join(appDir, "runtime");
  if (!isDir(appDir) || !isDir(runtime)) return { ok: false, reason: "missing" };
  try {
    if (fs.existsSync(link)) {
      const st = fs.lstatSync(link);
      if (st.isSymbolicLink() || st.isDirectory()) return { ok: true, already: true };
    }
  } catch {
    // create below
  }
  try {
    try {
      fs.rmSync(link, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (process.platform === "win32") {
      fs.symlinkSync("..\\runtime", link, "junction");
      return { ok: true, created: true, type: "junction" };
    }
    fs.symlinkSync("../runtime", link, "dir");
    return { ok: true, created: true, type: "dir" };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function stripShimEntryBlock(text) {
  return text.replace(/# dsh-purge cli entry begin[\s\S]*?# dsh-purge cli entry end\r?\n?/g, "");
}

function patchOfficialCliShimText(text) {
  if (!text) return { changed: false, text };
  // 老版本已改成 "$entry"、asar 原文不在了,但 BEGIN 标记还在 → 也要进来升级成三级回退。
  if (!text.includes(CLI_ASAR_ENTRY) && !text.includes(CLI_ENTRY_BEGIN)) return { changed: false, text };

  // 先铲掉旧块(可能是两级回退),再把裸 asar 路径归一成 "$entry",最后插入最新三级块,保证幂等升级。
  let next = stripShimEntryBlock(text);
  next = next.replace(
    /"\$resources\/app\.asar\/dsh\/node_modules\/@deepseek-ai\/dsh-desktop-host\/lib\/cli\.js"/g,
    '"$entry"',
  );
  next = next.replace(
    /\$resources\/app\.asar\/dsh\/node_modules\/@deepseek-ai\/dsh-desktop-host\/lib\/cli\.js/g,
    '"$entry"',
  );
  if (!next.includes('"$entry"')) return { changed: false, text };

  const block = [
    CLI_ENTRY_BEGIN,
    `entry="$resources/${CLI_ASAR_ENTRY}"`,
    `if [ ! -f "$entry" ]; then entry="$resources/${CLI_UNPACKED_ENTRY}"; fi`,
    `if [ ! -f "$entry" ]; then entry="$resources/${CLI_DIR_ENTRY}"; fi`,
    CLI_ENTRY_END,
    "",
  ].join("\n");
  const insertAt = next.search(/ELECTRON_RUN_AS_NODE=1/);
  if (insertAt >= 0) {
    // 插到该行行首,避免把 `export ELECTRON_RUN_AS_NODE=1` 从中间劈开。
    const lineStart = next.lastIndexOf("\n", insertAt) + 1;
    next = `${next.slice(0, lineStart)}${block}${next.slice(lineStart)}`;
  } else {
    next = `${block}${next}`;
  }

  if (next === text) return { changed: false, text, already: true };
  return { changed: true, text: next };
}

const CMD_ENTRY_BEGIN = "REM dsh-purge cli entry begin";
const CMD_ENTRY_END = "REM dsh-purge cli entry end";
const CMD_CLI_TAIL = "dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js";

function cmdEntryAlreadyGood(text) {
  if (!text.includes(CMD_ENTRY_BEGIN) || !text.includes(CMD_ENTRY_END)) return false;
  if (/set\s+"entry=%entry%"/i.test(text)) return false;
  if (!/set\s+"entry=%~dp0[^"\r\n]*app\.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli\.js"/i.test(text)) return false;
  // #94:必须含 app.asar.unpacked 这一级回退,否则判为旧块强制升级。
  if (!/if not exist "%entry%" set "entry=%~dp0[^"\r\n]*app\.asar\.unpacked\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli\.js"/i.test(text)) return false;
  if (!/if not exist "%entry%" set "entry=%~dp0[^"\r\n]*app\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli\.js"/i.test(text)) return false;
  const outside = text.replace(/set\s+"entry=[^"]*"/gi, "");
  if (/app\.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli\.js/i.test(outside)) return false;
  return /"%entry%"/.test(text);
}

function stripCmdEntryBlock(text) {
  return text.replace(/\r?\n?REM dsh-purge cli entry begin[\s\S]*?REM dsh-purge cli entry end\r?\n?/gi, "\r\n");
}

function replaceQuotedInsensitive(text, pathValue, replacement) {
  const needle = `"${pathValue}"`;
  const lower = text.toLowerCase();
  const want = needle.toLowerCase();
  let out = "";
  let i = 0;
  while (i < text.length) {
    const at = lower.indexOf(want, i);
    if (at < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, at) + replacement;
    i = at + needle.length;
  }
  return out;
}

/** Windows 官方 dsh.cmd 用 %~dp0，没有 %resources%。先改原文，再插入回退，避免正则改到刚插入的行。 */
export function patchOfficialCliCmdText(text) {
  if (!text) return { changed: false, text };
  const hasAsar = text.toLowerCase().includes("app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js")
    || text.includes(CLI_ASAR_ENTRY);
  const hasMarker = text.includes(CMD_ENTRY_BEGIN);
  if (!hasAsar && !hasMarker) return { changed: false, text };
  if (cmdEntryAlreadyGood(text)) return { changed: false, text, already: true };

  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  // 先从原文(含旧块的 set 行)取 %~dp0 前缀,这样两级旧块也能升级成三级。
  const found = text.match(/%~dp0[^"\r\n]*?app\.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli\.js/i);
  if (!found) return { changed: false, text };
  const cut = found[0].toLowerCase().indexOf("app.asar\\");
  if (cut < 0) return { changed: false, text };
  const prefix = found[0].slice(0, cut);
  let next = stripCmdEntryBlock(text);
  next = replaceQuotedInsensitive(next, `${prefix}app.asar\\${CMD_CLI_TAIL}`, '"%entry%"');
  next = replaceQuotedInsensitive(next, `${prefix}app.asar.unpacked\\${CMD_CLI_TAIL}`, '"%entry%"');
  next = replaceQuotedInsensitive(next, `${prefix}app\\${CMD_CLI_TAIL}`, '"%entry%"');
  const block = [
    CMD_ENTRY_BEGIN,
    `set "entry=${prefix}app.asar\\${CMD_CLI_TAIL}"`,
    `if not exist "%entry%" set "entry=${prefix}app.asar.unpacked\\${CMD_CLI_TAIL}"`,
    `if not exist "%entry%" set "entry=${prefix}app\\${CMD_CLI_TAIL}"`,
    CMD_ENTRY_END,
    "",
  ].join(nl);
  const insertAt = next.search(/ELECTRON_RUN_AS_NODE=1/);
  if (insertAt >= 0) {
    const lineEnd = next.indexOf("\n", insertAt);
    const at = lineEnd >= 0 ? lineEnd + 1 : next.length;
    next = `${next.slice(0, at)}${block}${next.slice(at)}`;
  } else {
    next = block + next;
  }
  if (/set\s+"entry=%entry%"/i.test(next)) return { changed: false, text };
  if (!/"%entry%"/.test(next)) return { changed: false, text };
  if (!cmdEntryAlreadyGood(next)) return { changed: false, text };
  return { changed: next !== text, text: next };
}

/**
 * 解包 app.asar 之后修补官方 CLI：入口回退到 app/，并补 app/runtime → ../runtime。
 * 备份 dsh.cmd 是可选的。失败只记在 shims[].backup,不得抛出,也不得挡壳补丁和挪走 app.asar。
 * 必须 await atomicCopyFile:同步 try/catch 接不住 Promise 拒绝,Windows 上 rename ENOENT
 * 会变成未处理拒绝,宿主 exit 1。
 */
export async function repairOfficialCliAfterUnpack(exe) {
  try {
    const target = exe || findDesktopAppExecutable();
    if (!target || !isOfficialHarnessExecutable(target)) return { ok: false, reason: "not_official" };
    const resources = resourcesDirForExecutable(target);
    if (!resources || !isDir(resources)) return { ok: false, reason: "no_resources" };
    const report = { ok: true, resources, symlink: null, shims: [] };
    report.symlink = ensureAppRuntimeSymlink(resources);
    const shimPaths = [
      path.join(resources, "runtime", "cli", "bin", "dsh"),
      path.join(resources, "runtime", "cli", "bin", "dsh.cmd"),
    ];
    for (const fp of shimPaths) {
      if (!isFile(fp)) {
        report.shims.push({ path: fp, status: "missing" });
        continue;
      }
      let text = "";
      try {
        text = fs.readFileSync(fp, "utf8");
      } catch (e) {
        report.shims.push({ path: fp, status: "read_error", error: String(e && e.message ? e.message : e) });
        continue;
      }
      const patched = fp.toLowerCase().endsWith(".cmd")
        ? patchOfficialCliCmdText(text)
        : patchOfficialCliShimText(text);
      if (!patched.changed) {
        report.shims.push({ path: fp, status: patched.already ? "already" : "skipped" });
        continue;
      }
      let backup = "skipped";
      let backupError = "";
      const bak = `${fp}.dsh-purge.bak`;
      if (!isFile(bak)) {
        try {
          await atomicCopyFile(fp, bak);
          backup = "saved";
        } catch (e) {
          backup = "failed";
          backupError = String(e && e.message ? e.message : e);
          logInternal(`cli bak skipped ${fp}: ${backupError}`);
        }
      } else {
        backup = "exists";
      }
      try {
        atomicWriteSync(fp, patched.text, "utf8");
        report.shims.push({
          path: fp,
          status: "patched",
          backup,
          ...(backupError ? { error: backupError } : {}),
        });
      } catch (e) {
        const writeError = String(e && e.message ? e.message : e);
        report.shims.push({
          path: fp,
          status: "write_error",
          backup,
          error: backupError ? `${backupError}; ${writeError}` : writeError,
        });
      }
    }
    return report;
  } catch (e) {
    logInternal("repair official CLI failed: " + (e && e.message ? e.message : e));
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}
