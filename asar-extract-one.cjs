#!/usr/bin/node
// 从 asar 归档按字节精确抽取单个文件(asar 格式:2 个 pickle 头 + JSON 目录)
const fs = require("fs");
const [,, archive, innerPath, outPath] = process.argv;
const buf = fs.readFileSync(archive);
// pickle: [uint32 headerPickleSize][uint32 ??? ][uint32 jsonLen][json...]
const headerSize = buf.readUInt32LE(4);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.slice(16, 16 + jsonLen).toString("utf8"));
let node = json;
for (const part of innerPath.split("/")) {
  if (!node.files || !node.files[part]) { console.error("not found:", part); process.exit(1); }
  node = node.files[part];
}
if (node.unpacked) { console.error("file is unpacked"); process.exit(1); }
const base = 8 + headerSize; // data 区起点
const data = buf.slice(base + Number(node.offset), base + Number(node.offset) + node.size);
fs.writeFileSync(outPath, data);
console.log("extracted:", innerPath, "| size:", node.size);
