#!/usr/bin/env node
/**
 * migrate-config.mjs —— 两旧行 → 一行 web-custom 的离线配置迁移。
 *
 * 场景：desktop profile 的 cordis.patch.yml 里同时有
 *   - id: web-search-custom   (15 键，泛名 api/url/apiKey/...)
 *   - id: web-fetch           (14 键，已按数据源前缀命名)
 * 本脚本把两行 config 合成新的 29 键 web-custom config：
 *   - 搜索侧 15 键按计划书 §4 映射表加 search 前缀；
 *   - 抓取侧 14 键原样搬运；
 *   - 默认只在终端打印「键名 ← 旧行.旧键 / 是否密钥 / 是否有值」，绝不回显值；
 *   - --out <file> 才把真实值写成候选补丁（文件含密钥，用完请删除）。
 *
 * 用法：
 *   node tools/migrate-config.mjs                        # 只打印迁移报告（默认 patch 路径）
 *   node tools/migrate-config.mjs --patch <path>         # 指定 profile 的 cordis.patch.yml
 *   node tools/migrate-config.mjs --check                # 预检：缺行 / 缺密钥时 exit 1
 *   node tools/migrate-config.mjs --out <file>           # 写出候选补丁（含真实密钥）
 *
 * 注意：本脚本不安装插件、不改 profile、不重启宿主；切换动作本身由人工在宿主停止时完成。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_KEYS } from "../src/config.js";

const DEFAULT_PATCH = join(homedir(), ".dsh", "profiles", "desktop", "cordis.patch.yml");
const SEARCH_ROW = "web-search-custom";
const FETCH_ROW = "web-fetch";

/** 计划书 §4 映射表：旧搜索键 → 新 search* 键。 */
const SEARCH_MAP = [
  ["api", "searchApi"], ["url", "searchUrl"], ["apiKey", "searchApiKey"],
  ["maxResults", "searchMaxResults"], ["method", "searchMethod"], ["body", "searchBody"],
  ["headers", "searchHeaders"], ["authHeader", "searchAuthHeader"], ["authScheme", "searchAuthScheme"],
  ["timeoutMs", "searchTimeoutMs"], ["resultsPath", "searchResultsPath"], ["urlField", "searchUrlField"],
  ["titleField", "searchTitleField"], ["snippetField", "searchSnippetField"], ["publishedField", "searchPublishedField"]
];
/** 抓取侧 14 键同名搬运。 */
const FETCH_KEYS = [
  "cdpEnabled", "cdpEndpoint", "cdpTimeoutMs", "cdpWaitMs",
  "tavilyEnabled", "tavilyEndpoint", "tavilyApiKey", "tavilyTimeoutMs",
  "anysearchEnabled", "anysearchEndpoint", "anysearchApiKey", "anysearchTimeoutMs",
  "anysearchFallbackToHttp", "anysearchMaxChars"
];
const SECRET_KEYS = new Set(["searchApiKey", "tavilyApiKey", "anysearchApiKey"]);

function usage(message) {
  if (message) console.error("error: " + message);
  console.error("usage: node tools/migrate-config.mjs [--patch <cordis.patch.yml>] [--out <file>] [--check]");
  process.exit(2);
}

function parseArgs(argv) {
  const args = { patch: DEFAULT_PATCH, out: undefined, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--patch") { args.patch = argv[++i]; if (!args.patch) usage("--patch needs a path"); }
    else if (arg === "--out") { args.out = argv[++i]; if (!args.out) usage("--out needs a path"); }
    else if (arg === "--check") args.check = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage("unknown argument: " + arg);
  }
  return args;
}

/** 去掉 YAML 标量外层的引号并还原基本类型。 */
function parseScalar(raw) {
  const text = raw.trim();
  if (text === "" || text === "''" || text === '""') return "";
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

/** 取出某个 patch 行的 config 对象（只读，不解释整份 YAML）。 */
function readRowConfig(lines, rowId) {
  const rowPattern = new RegExp("^\\s*-\\s+id:\\s*" + rowId + "\\s*$");
  for (let i = 0; i < lines.length; i += 1) {
    if (!rowPattern.test(lines[i])) continue;
    let configIndent = -1;
    const config = {};
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (/^\s*-\s+\w/.test(line) && !/^\s*config:/.test(line)) break; // next list item
      const configMatch = /^(\s*)config:\s*$/.exec(line);
      if (configMatch) { configIndent = configMatch[1].length; continue; }
      if (configIndent < 0) continue;
      const keyMatch = /^(\s+)([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
      if (!keyMatch) continue;
      if (keyMatch[1].length !== configIndent + 2) continue;
      const key = keyMatch[2];
      if (Object.hasOwn(config, key)) continue;
      config[key] = parseScalar(keyMatch[3]);
    }
    return config;
  }
  return undefined;
}

function emitScalar(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value ?? "");
  if (text === "") return "''";
  if (/^[A-Za-z0-9_./-]+$/.test(text)) return text;
  return "'" + text.replace(/'/g, "''") + "'";
}

const args = parseArgs(process.argv.slice(2));
const lines = readFileSync(args.patch, "utf8").split(/\r?\n/);
const search = readRowConfig(lines, SEARCH_ROW) ?? {};
const fetchRow = readRowConfig(lines, FETCH_ROW) ?? {};
const missingRows = [];
if (readRowConfig(lines, SEARCH_ROW) === undefined) missingRows.push(SEARCH_ROW);
if (readRowConfig(lines, FETCH_ROW) === undefined) missingRows.push(FETCH_ROW);

const mapped = new Map();
const report = [];
for (const [oldKey, newKey] of SEARCH_MAP) {
  const present = Object.hasOwn(search, oldKey);
  mapped.set(newKey, present ? search[oldKey] : undefined);
  report.push({ source: SEARCH_ROW + "." + oldKey, target: newKey, secret: SECRET_KEYS.has(newKey), present });
}
for (const key of FETCH_KEYS) {
  const present = Object.hasOwn(fetchRow, key);
  mapped.set(key, present ? fetchRow[key] : undefined);
  report.push({ source: FETCH_ROW + "." + key, target: key, secret: SECRET_KEYS.has(key), present });
}

const targets = report.map((row) => row.target);
const unknown = targets.filter((key) => !CONFIG_KEYS.includes(key));
const duplicates = targets.filter((key, index) => targets.indexOf(key) !== index);
const uncovered = CONFIG_KEYS.filter((key) => !targets.includes(key));
if (unknown.length > 0 || duplicates.length > 0 || uncovered.length > 0) {
  console.error("internal mapping drift: unknown=" + unknown.join(",") + " duplicates=" + duplicates.join(",") + " uncovered=" + uncovered.join(","));
  process.exit(2);
}

console.log("patch: " + args.patch);
console.log("rows:  " + SEARCH_ROW + " + " + FETCH_ROW + " → web-custom（29 键）");
if (missingRows.length > 0) console.log("MISSING ROWS: " + missingRows.join(", "));
console.log("");
for (const row of report) {
  const valueState = !row.present ? "旧键缺失" : row.secret ? (String(mapped.get(row.target) ?? "") === "" ? "空" : "已设置") : "有值";
  const pad = (text, width) => text + " ".repeat(Math.max(1, width - text.length));
  console.log("  " + pad(row.target, 24) + "← " + pad(row.source, 36) + valueState + (row.secret ? "   [密钥]" : ""));
}

const missingSecrets = report.filter((row) => row.secret && String(mapped.get(row.target) ?? "") === "").map((row) => row.target);
const missingKeys = report.filter((row) => !row.present).map((row) => row.target);
console.log("");
console.log("summary: 字段 " + report.length + "/29；旧键缺失 " + missingKeys.length + "；空密钥 " + missingSecrets.length);
if (missingKeys.length > 0) console.log("  缺失旧键: " + missingKeys.join(", "));
if (missingSecrets.length > 0) console.log("  空密钥:   " + missingSecrets.join(", "));

if (args.out !== undefined) {
  const body = CONFIG_KEYS.map((key) => "        " + key + ": " + emitScalar(mapped.get(key))).join("\n");
  const document = [
    "# generated by tools/migrate-config.mjs on " + new Date().toISOString(),
    "# WARNING: this file contains real API keys — delete it after pasting into the profile patch.",
    "- insert:",
    "    - id: web-custom",
    "      name: 'dsh-web-custom'",
    "      config:",
    body,
    ""
  ].join("\n");
  writeFileSync(args.out, document, "utf8");
  console.log("written: " + args.out + "（含真实密钥，用完删除）");
} else {
  console.log("dry-run: 未写文件；需要含真实值的候选补丁时加 --out <file>");
}

if (args.check && (missingRows.length > 0 || missingKeys.length > 0)) {
  console.error("check failed: add the missing legacy rows/keys before switching");
  process.exit(1);
}
