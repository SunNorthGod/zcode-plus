// 两版 zcode.cjs 的 keepNames 语义级 diff:node fnames-diff.cjs [旧版路径 新版路径]
const fs = require("fs");
function names(p) {
  const s = fs.readFileSync(p, "utf8");
  const set = new Map();
  const re = /r\(([\w$]+),"([A-Za-z0-9_$]+)"\)/g;
  let m;
  while ((m = re.exec(s))) set.set(m[2], (set.get(m[2]) || 0) + 1);
  return set;
}
const A = names(process.argv[2] ?? "pristine-3153/zcode.cjs.pristine");
const B = names(process.argv[3] ?? "pristine-3161/zcode.cjs.pristine");
const added = [], removed = [];
for (const [k, v] of B) if (!A.has(k)) added.push(k + "x" + v);
for (const [k] of A) if (!B.has(k)) removed.push(k);
console.log("semantic names: 3153 =", A.size, "| 3161 =", B.size);
console.log("ADDED (" + added.length + "):");
console.log(added.join("\n"));
console.log("REMOVED (" + removed.length + "):");
console.log(removed.slice(0, 60).join("\n"));
