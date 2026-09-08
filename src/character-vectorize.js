// Deterministic first importer profile: dark, monochrome artwork on a white or
// transparent background. No model, file access, SVG parsing or anatomy guesses.
const MAX_PIXELS = 4 * 1024 * 1024;
const MAX_EDGES = 24000;

function contours(mask, tones, width, height) {
  const stride = width + 1, edges = [], outgoing = new Map();
  function edge(x, y, dx, dy, direction, insideX, insideY, outsideX, outsideY) {
    if (edges.length >= MAX_EDGES) throw new Error("轮廓过于复杂，请使用更简洁的单色角色图。");
    const from = y * stride + x, to = (y + dy) * stride + x + dx;
    const id = edges.length;
    const inside = tones[insideY * width + insideX];
    const outside = outsideX < 0 || outsideY < 0 || outsideX >= width || outsideY >= height
      ? 255 : tones[outsideY * width + outsideX];
    const t = inside === outside ? .5 : Math.max(.05, Math.min(.95, (160 - inside) / (outside - inside)));
    const point = [insideX + .5 + (outsideX - insideX) * t, insideY + .5 + (outsideY - insideY) * t];
    edges.push({ from, to, direction, point, used: false });
    if (!outgoing.has(from)) outgoing.set(from, []);
    outgoing.get(from).push(id);
  }
  const at = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!at(x, y)) continue;
    if (!at(x, y - 1)) edge(x, y, 1, 0, 0, x, y, x, y - 1);
    if (!at(x + 1, y)) edge(x + 1, y, 0, 1, 1, x, y, x + 1, y);
    if (!at(x, y + 1)) edge(x + 1, y + 1, -1, 0, 2, x, y, x, y + 1);
    if (!at(x - 1, y)) edge(x, y + 1, 0, -1, 3, x, y, x - 1, y);
  }
  const loops = [], priority = [1, 0, 3, 2];
  for (const first of edges) {
    if (first.used) continue;
    const points = [];
    let current = first;
    do {
      current.used = true;
      points.push(current.point);
      if (current.to === first.from) break;
      const choices = (outgoing.get(current.to) || []).map(id => edges[id]).filter(item => !item.used);
      choices.sort((a, b) => priority.indexOf((a.direction - current.direction + 4) % 4)
        - priority.indexOf((b.direction - current.direction + 4) % 4));
      if (!choices.length) throw new Error("无法闭合角色轮廓。");
      current = choices[0];
    } while (true);
    loops.push(points);
  }
  return loops;
}

function simplify(points, tolerance) {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop(), a = points[start], b = points[end];
    const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
    let furthest = -1, maxDistance = tolerance * tolerance;
    for (let i = start + 1; i < end; i++) {
      const p = points[i];
      const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
      const distance = (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
      if (distance > maxDistance) { maxDistance = distance; furthest = i; }
    }
    if (furthest >= 0) {
      keep[furthest] = 1;
      stack.push([start, furthest], [furthest, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function pathFor(points, mapPoint) {
  // Split the closed contour before simplifying; keep corner rounding bounded
  // to less than one source pixel rather than freely refitting the silhouette.
  let far = 1, distance = 0;
  for (let i = 1; i < points.length; i++) {
    const d = (points[i][0] - points[0][0]) ** 2 + (points[i][1] - points[0][1]) ** 2;
    if (d > distance) { distance = d; far = i; }
  }
  const vertices = [
    ...simplify(points.slice(0, far + 1), .25).slice(0, -1),
    ...simplify([...points.slice(far), points[0]], .25).slice(0, -1),
  ];
  const corners = vertices.map((point, i) => {
    const previous = vertices[(i + vertices.length - 1) % vertices.length];
    const next = vertices[(i + 1) % vertices.length];
    const before = Math.hypot(previous[0] - point[0], previous[1] - point[1]);
    const after = Math.hypot(next[0] - point[0], next[1] - point[1]);
    const radius = Math.min(.85, before / 2, after / 2);
    const along = (target, length) => mapPoint(point.map((value, axis) => value + (target[axis] - value) * radius / length)).join(" ");
    return { start: along(previous, before), control: mapPoint(point).join(" "), end: along(next, after) };
  });
  return corners.map((corner, i) => (i ? "L" : "M") + corner.start + "Q" + corner.control + " " + corner.end).join("") + "Z";
}

export function vectorizeMonochrome({ data, width, height }) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 3 || height < 3
    || width * height > MAX_PIXELS || !(data instanceof Uint8Array) || data.length !== width * height * 4) {
    throw new Error("需要总像素不超过 4,194,304 的 RGBA 图片。");
  }
  const dark = new Uint8Array(width * height), light = new Uint8Array(width * height);
  const tones = new Uint8Array(width * height).fill(255);
  const histogram = new Uint32Array(256);
  let count = 0, colored = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  for (let i = 0; i < dark.length; i++) {
    const [r, g, b, alpha] = data.subarray(i * 4, i * 4 + 4);
    if (alpha < 128) continue;
    const brightness = Math.round((r + g + b) / 3);
    tones[i] = brightness;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 24) colored++;
    if (brightness >= 160) continue;
    dark[i] = 1; count++; histogram[brightness]++;
    const x = i % width, y = Math.floor(i / width);
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (!count) throw new Error("未找到深色角色；当前只支持白底或透明底的单色形象。");
  if (colored > Math.max(4, count * .01)) throw new Error("当前转换器只支持单色形象，不会自动丢弃彩色细节。");
  if (minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1) {
    throw new Error("深色轮廓接触图片边缘，请提供完整角色和少量背景留白。");
  }
  // Flood-fill the exterior. Enclosed opaque white regions remain white (eyes
  // in this sample); enclosed transparent regions stay transparent.
  const outside = new Uint8Array(dark.length), queue = new Uint32Array(dark.length);
  let head = 0, tail = 0;
  const push = i => { if (!dark[i] && !outside[i]) { outside[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
  while (head < tail) {
    const i = queue[head++], x = i % width;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (i >= width) push(i - width);
    if (i < dark.length - width) push(i + width);
  }
  for (let i = 0; i < light.length; i++) {
    if (!dark[i] && !outside[i] && data[i * 4 + 3] >= 128) light[i] = 1;
  }
  const darkContours = contours(dark, tones, width, height), lightContours = contours(light, tones, width, height);
  if (darkContours.length > 64 || lightContours.length > 64) throw new Error("细碎区域过多，请使用简洁的单色形象。");
  const bounds = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  const scale = 56 / Math.max(bounds.width, bounds.height);
  const offsetX = (64 - bounds.width * scale) / 2 - minX * scale;
  const offsetY = 60 - (maxY + 1) * scale;
  const mapPoint = ([x, y]) => [(x * scale + offsetX).toFixed(3), (y * scale + offsetY).toFixed(3)];
  const gray = histogram.indexOf(Math.max(...histogram));
  const color = "#" + gray.toString(16).padStart(2, "0").repeat(3);
  const darkPath = darkContours.map(points => pathFor(points, mapPoint)).join("");
  const lightPath = lightContours.map(points => pathFor(points, mapPoint)).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">\n`
    + `  <path d="${darkPath}" fill="${color}" fill-rule="evenodd"/>\n`
    + (lightPath ? `  <path d="${lightPath}" fill="#ffffff" fill-rule="evenodd"/>\n` : "")
    + `</svg>\n`;
  return {
    svg,
    report: {
      profile: "monochrome-v1", width, height, bounds, color,
      darkContours: darkContours.length, lightContours: lightContours.length,
      transform: { scale, offsetX, offsetY },
      limitations: ["白底或透明底、单色深色角色", "按阈值二值化，不保留灰阶纹理", "移除外部浅色区域及浅灰阴影", "不识别或补画身体部件", "边缘按像素轮廓近似"],
    },
  };
}

function colorDistance(a, b) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

// Prepare a flat-color illustration for a trusted PNG wrapper. Transparent
// backgrounds are preserved; opaque images must have a consistent corner color
// that can be flood-filled without deleting enclosed character details.
export function prepareColorRaster({ data, width, height }) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 3 || height < 3
    || width * height > MAX_PIXELS || !(data instanceof Uint8Array) || data.length !== width * height * 4) {
    throw new Error("需要总像素不超过 4,194,304 的 RGBA 图片。");
  }
  const output = new Uint8Array(data), pixels = width * height;
  let transparent = 0;
  for (let i = 0; i < pixels; i++) if (output[i * 4 + 3] < 64) transparent++;
  let backgroundRemoved = false;
  if (transparent < Math.max(4, pixels * .002)) {
    const corners = [[0,0],[width-1,0],[0,height-1],[width-1,height-1]].map(([x,y]) => {
      const i = (y * width + x) * 4; return [output[i], output[i+1], output[i+2]];
    });
    if (corners.some(color => colorDistance(color, corners[0]) > 28)) {
      throw new Error("彩色图片需要透明背景，或四角颜色一致的纯色背景。");
    }
    const background = corners.reduce((sum, color) => sum.map((value, i) => value + color[i] / corners.length), [0,0,0]);
    const outside = new Uint8Array(pixels), queue = new Uint32Array(pixels);
    let head = 0, tail = 0;
    const push = index => {
      if (outside[index]) return;
      const i = index * 4, color = [output[i], output[i+1], output[i+2]];
      if (colorDistance(color, background) > 34) return;
      outside[index] = 1; queue[tail++] = index;
    };
    for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
    while (head < tail) {
      const index = queue[head++], x = index % width;
      if (x > 0) push(index - 1);
      if (x < width - 1) push(index + 1);
      if (index >= width) push(index - width);
      if (index < pixels - width) push(index + width);
    }
    for (let i = 0; i < pixels; i++) if (outside[i]) output[i * 4 + 3] = 0;
    backgroundRemoved = true;
  }
  let minX = width, minY = height, maxX = -1, maxY = -1, foreground = 0;
  for (let i = 0; i < pixels; i++) if (output[i * 4 + 3] >= 64) {
    foreground++;
    const x = i % width, y = Math.floor(i / width);
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (foreground < pixels * .01) throw new Error("图片中没有足够清晰的角色主体。");
  if (foreground > pixels * .9) throw new Error("背景没有成功分离，请使用透明或纯色背景图片。");
  if (minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1) {
    throw new Error("角色接触图片边缘，请提供完整角色和少量背景留白。");
  }
  return {
    data: output,
    bounds: Object.freeze({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }),
    backgroundRemoved,
  };
}

export function mapPartBox(box, width, height, transform) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)
    || !Number.isFinite(transform?.scale) || !Number.isFinite(transform?.offsetX) || !Number.isFinite(transform?.offsetY)) {
    throw new Error("部件坐标转换参数无效。");
  }
  const left = Math.max(0, Math.min(64, box[0] * width * transform.scale + transform.offsetX));
  const top = Math.max(0, Math.min(64, box[1] * height * transform.scale + transform.offsetY));
  const right = Math.max(left, Math.min(64, (box[0] + box[2]) * width * transform.scale + transform.offsetX));
  const bottom = Math.max(top, Math.min(64, (box[1] + box[3]) * height * transform.scale + transform.offsetY));
  return [left / 64, top / 64, (right - left) / 64, (bottom - top) / 64].map(value => Number(value.toFixed(4)));
}
