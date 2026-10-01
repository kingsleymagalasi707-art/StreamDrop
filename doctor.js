const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function check(command, args, label) {
  const r = spawnSync(command, args, { encoding: "utf8", timeout: 10000, windowsHide: true });
  if (r.error) return { ok: false, label, detail: r.error.message };
  if (r.status !== 0) return { ok: false, label, detail: (r.stderr || r.stdout || `exit ${r.status}`).trim().split("\n").slice(-1)[0] };
  return { ok: true, label, detail: (r.stdout || r.stderr || "available").trim().split("\n")[0] };
}

const results = [
  { ok: Number(process.versions.node.split(".")[0]) >= 18, label: "Node.js", detail: process.version },
  check(process.env.YTDLP_BIN || "yt-dlp", ["--version"], "yt-dlp"),
  check(process.env.FFMPEG_BIN || "ffmpeg", ["-version"], "FFmpeg")
];
const temp = process.env.VEYRA_TEMP_DIR || process.env.STREAMDROP_TEMP_DIR || path.join(require("node:os").tmpdir(), "veyra");
try { fs.mkdirSync(temp, { recursive: true }); results.push({ ok: true, label: "Temporary directory", detail: temp }); }
catch (e) { results.push({ ok: false, label: "Temporary directory", detail: e.message }); }

console.log("\nVeyra launch check\n=======================");
for (const r of results) console.log(`${r.ok ? "OK   " : "FAIL "}${r.label}: ${r.detail}`);
const failed = results.filter(r => !r.ok);
if (failed.length) {
  console.log("\nFix the FAIL items before using Veyra in production.");
  process.exitCode = 1;
} else {
  console.log("\nAll required local checks passed. Run: npm start");
}
