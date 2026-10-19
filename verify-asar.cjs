// 新旧 asar 头对头:文件清单零缺失、旗标/尺寸零差异(唯一例外=补丁 chunk)、unpacked 文件逐字节一致
// 用法:node verify-asar.cjs [原版.asar 新版.asar 原版.unpacked目录 新版.unpacked目录]
const fs = require("fs");
function head(p) {
  const buf = fs.readFileSync(p);
  const headerSize = buf.readUInt32LE(4);
  const jsonLen = buf.readUInt32LE(12);
  return JSON.parse(buf.slice(16, 16 + jsonLen).toString("utf8"));
}
const A = head(process.argv[2] ?? "pristine-3161/app.asar");
const B = head(process.argv[3] ?? "asar-work/app.asar.new");
const flat = (n, p, out) => {
  for (const k in n.files) {
    const v = n.files[k];
    const fp = p + "/" + k;
    if (v.files) flat(v, fp, out);
    else out.push([fp, v]);
  }
  return out;
};
const fa = new Map(flat(A, "", []));
const fb = new Map(flat(B, "", []));
console.log("files: orig", fa.size, "| new", fb.size);
let missing = 0, extra = 0, flagDiff = [], sizeDiff = [];
for (const [fp, v] of fa) {
  const w = fb.get(fp);
  if (!w) { missing++; if (missing < 8) console.log("MISSING:", fp); continue; }
  if (!!v.unpacked !== !!w.unpacked) { flagDiff.push(fp); continue; }
  // unpacked 条目的 header size 官方记法与 @electron/asar 不同(真实文件已另证 sha 逐字节一致),跳过
  if (v.unpacked) continue;
  if (v.size !== w.size) sizeDiff.push([fp, v.size, w.size]);
}
for (const fp of fb.keys()) if (!fa.has(fp)) { extra++; console.log("EXTRA:", fp); }
console.log("missing:", missing, "| extra:", extra, "| flag-diff:", flagDiff.length, "| size-diff:", sizeDiff.length);
sizeDiff.forEach(([f, a, b]) => console.log("  SIZE:", f, a, "->", b, "(" + (b - a) + "B)"));
// unpacked 12 文件逐字节
const crypto = require("crypto");
const path = require("path");
let upOK = 0, upBad = 0;
function walk(dir, rel) {
  for (const k of fs.readdirSync(dir)) {
    const dp = path.join(dir, k), rp = rel ? rel + "/" + k : k;
    const st = fs.statSync(dp);
    if (st.isDirectory()) walk(dp, rp);
    else {
      const src = path.join(process.argv[4] ?? "pristine-3161/app.asar.unpacked", rp);
      const h1 = crypto.createHash("sha256").update(fs.readFileSync(dp)).digest("hex");
      const h2 = crypto.createHash("sha256").update(fs.readFileSync(src)).digest("hex");
      h1 === h2 ? upOK++ : (upBad++, console.log("UNPACKED DIFF:", rp));
    }
  }
}
walk(process.argv[5] ?? "asar-work/app.asar.new.unpacked", "");
console.log("unpacked byte-identical:", upOK, "| diff:", upBad);
const pass = missing === 0 && extra === 0 && flagDiff.length === 0 && sizeDiff.length === 1 && sizeDiff[0][0].includes("styles-") && upBad === 0;
console.log(pass ? "HEAD-TO-HEAD: PASS" : "HEAD-TO-HEAD: FAIL");
process.exit(pass ? 0 : 1);
