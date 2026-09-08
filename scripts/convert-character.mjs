import { open, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { vectorizeMonochrome } from "../src/character-vectorize.js";

// Developer CLI only. Electron runtime does not gain filesystem/network APIs or
// a dependency on sharp. A future user-facing importer needs its own worker/UI.
const [input, output, ...extra] = process.argv.slice(2);
async function readInput(filename) {
  const handle = await open(filename, "r");
  try {
    const maximum = 10 * 1024 * 1024;
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error("需要不超过 10 MB 的图片文件。");
    // Bound allocation and read length even if a local file grows after stat.
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error("图片不能超过 10 MB。");
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
if (!input || !output || extra.length) {
  console.error("用法：npm run character:convert -- <input.png|jpg> <新的输出目录>");
  process.exitCode = 1;
} else {
  try {
    const bytes = await readInput(input);
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!png && !jpeg) throw new Error("仅支持 PNG 或 JPG 图片，不按文件扩展名猜测格式。");
    const decoder = sharp(bytes, { limitInputPixels: 4 * 1024 * 1024, animated: false });
    const metadata = await decoder.metadata();
    if (!["png", "jpeg"].includes(metadata.format) || (metadata.pages || 1) > 1) {
      throw new Error("仅支持单帧 PNG 或 JPG。");
    }
    const { data, info } = await decoder.rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const result = vectorizeMonochrome({ data, width: info.width, height: info.height });
    // Never overwrite an earlier conversion or the supplied source.
    await mkdir(output);
    await writeFile(path.join(output, "character.svg"), result.svg, { flag: "wx" });
    await writeFile(path.join(output, "conversion.json"), JSON.stringify({
      ...result.report,
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      svgSha256: createHash("sha256").update(result.svg).digest("hex"),
    }, null, 2) + "\n", { flag: "wx" });
    console.log(`已生成 ${path.resolve(output, "character.svg")}（${Buffer.byteLength(result.svg)} bytes）`);
    console.log("仅完成单色矢量化，未生成眼睛/尾巴绑定，也未安装到桌面宠物。");
  } catch (error) {
    console.error(error.code === "EEXIST" ? "输出目录已存在，请使用新的目录。" : error.message);
    process.exitCode = 1;
  }
}
