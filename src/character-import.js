// Narrow raster envelope check, before passing bytes to the sandbox decoder.
// Not an image decoder: malformed compressed data is rejected by Chromium.
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 4 * 1024 * 1024;
export function inspectCharacterImage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_IMAGE_BYTES || bytes.length < 24)
    throw new Error("请选择不超过 10 MB 的 PNG 或 JPG 图片。");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  function dimensions(width, height, mime) {
    if (!width || !height || width * height > MAX_IMAGE_PIXELS)
      throw new Error("图片总像素不能超过 4,194,304，请先缩小图片。");
    return { width, height, mime };
  }
  if ([137,80,78,71,13,10,26,10].every((value, i) => bytes[i] === value)) {
    if (view.getUint32(8) !== 13 || tag(12, 4) !== "IHDR") throw new Error("PNG 文件头无效。");
    const info = dimensions(view.getUint32(16), view.getUint32(20), "image/png");
    let end = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset), type = tag(offset + 4, 4);
      if (offset + length + 12 > bytes.length) throw new Error("PNG 文件不完整。");
      if (type === "acTL") throw new Error("暂不支持动画 PNG，请导出一张静态图片。");
      if (type === "IEND") { end = true; break; }
      offset += length + 12;
    }
    if (!end) throw new Error("PNG 文件不完整。");
    return info;
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let info;
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 218 || marker === 217) break;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error("JPG 文件不完整。");
      if (marker === 226 && tag(offset + 2, 4) === "MPF\0") throw new Error("暂不支持多图 JPG。");
      if ([192,193,194].includes(marker)) {
        if (length < 8 || info) throw new Error("JPG 文件头无效。");
        info = dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3), "image/jpeg");
      }
      offset += length;
    }
    if (info) return info;
  }
  throw new Error("仅支持静态 PNG/JPG，不支持 SVG、照片合集或其他文件格式。");
}

// Accept only our generator's exact two-path grammar, never arbitrary SVG.
// No XML entities, styles, URLs, event handlers, images or supplied selectors.
export function validateGeneratedSvg(svg) {
  if (typeof svg !== "string" || svg.length > 750000) throw new Error("角色素材无效或过于复杂。");
  const prefix = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">\n';
  if (!svg.startsWith(prefix) || !svg.endsWith('</svg>\n')) throw new Error("角色格式无效。");
  const lines = svg.slice(prefix.length, -7).split('\n');
  if (lines.pop() !== "" || lines.length < 1 || lines.length > 2) throw new Error("角色素材无效。");
  if (lines.length === 1) {
    const raster = /^  <image href="data:image\/png;base64,([A-Za-z0-9+/]+={0,2})" x="0" y="0" width="64" height="64" preserveAspectRatio="xMidYMid meet"\/>$/.exec(lines[0]);
    if (raster) {
      if (raster[1].length > 700000 || !raster[1].startsWith("iVBORw0KGgo")) throw new Error("角色位图无效或过大。");
      let binary;
      try { binary = atob(raster[1]); } catch { throw new Error("角色位图无法读取。"); }
      if (binary.length < 24 || [137,80,78,71,13,10,26,10].some((byte, index) => binary.charCodeAt(index) !== byte)) {
        throw new Error("角色位图不是有效 PNG。");
      }
      inspectCharacterImage(Uint8Array.from(binary, character => character.charCodeAt(0)));
      return svg;
    }
  }
  for (const line of lines) {
    const match = /^  <path d="([MLQZ0-9., -]+)" fill="(#[0-9a-f]{6})" fill-rule="evenodd"\/>$/.exec(line);
    if (!match || !match[1].startsWith("M") || !match[1].endsWith("Z")) throw new Error("角色路径无效。");
    // Only absolute M/L/Q coordinates emitted by the converter, within viewBox.
    const commands = match[1].match(/[MLQZ][^MLQZ]*/g);
    if (commands.join("") !== match[1]) throw new Error("角色路径无效。");
    for (const command of commands) {
      const numbers = command.slice(1).trim().split(/[ ,]+/).filter(Boolean);
      if (numbers.length !== ({ M:2, L:2, Q:4, Z:0 })[command[0]] || numbers.some(n => !/^\d+(?:\.\d+)?$/.test(n) || +n > 64))
        throw new Error("角色坐标无效。");
    }
  }
  return svg;
}
