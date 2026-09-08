import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createCharacterStore } from "../src/character-store.js";
import { inspectCharacterImage, validateGeneratedSvg, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from "../src/character-import.js";

const sample = new URL("../assets/characters/black-cat/", import.meta.url);
const analysis = {
  quality: { decision: "pass", issues: [], explanation: "完整角色，背景简洁。" },
  persona: { archetype: "proud", voice: "reserved", identity: "一只测试黑猫", summary: "警觉而克制。", traits: ["警觉", "克制"] },
  parts: [{ kind: "body", confidence: .98, box: [.1,.1,.8,.8] }],
};
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "bluepet-character-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
test("raster boundary rejects oversized, animated, truncated and disguised files before decoding", async () => {
  const png = await readFile(new URL("source.png", sample));
  assert.deepEqual(inspectCharacterImage(png), { width:400,height:300,mime:"image/png" });
  const jpg = await sharp(png).jpeg().toBuffer();
  assert.equal(inspectCharacterImage(jpg).mime, "image/jpeg");
  const withinLimit = Buffer.from(png); withinLimit.writeUInt32BE(1200, 16); withinLimit.writeUInt32BE(1200, 20);
  assert.deepEqual(inspectCharacterImage(withinLimit), { width:1200,height:1200,mime:"image/png" });
  assert.equal(MAX_IMAGE_PIXELS, 4_194_304);
  assert.throws(() => inspectCharacterImage(Buffer.alloc(MAX_IMAGE_BYTES + 1)), /10 MB/);
  assert.throws(() => inspectCharacterImage(Buffer.from('<svg onload="alert(1)">not png</svg>')), /PNG\/JPG/);
  assert.throws(() => inspectCharacterImage(png.subarray(0, 40)), /不完整/);
  const oversized = Buffer.from(png); oversized.writeUInt32BE(20000, 16);
  assert.throws(() => inspectCharacterImage(oversized), /总像素/);
  const animated = Buffer.concat([png.subarray(0,33), Buffer.from([0,0,0,0,97,99,84,76,0,0,0,0]), png.subarray(33)]);
  assert.throws(() => inspectCharacterImage(animated), /动画/);
});
test("generated SVG grammar rejects executable XML, arbitrary attributes and unbounded coordinates", async () => {
  const svg = await readFile(new URL("character.svg", sample), "utf8");
  assert.equal(validateGeneratedSvg(svg), svg);
  for (const bad of [svg.replace('<path ', '<path onload="alert(1)" '), svg.replace('</svg>', '<script/>\n</svg>'), svg.replace('fill="#111111"', 'fill="url(https://evil.test)"'), svg.replace(/d="M[^Q]+Q/, 'd="M999 1Q'), svg.replace(/d="M[^Q]+Q/, 'd="MNaN 1Q'), svg.replace(/d="M[^Q]+Q/, 'd="M1 1 1Q'), svg.replace('<svg ', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg '), svg.repeat(200)]) {
    assert.throws(() => validateGeneratedSvg(bad));
  }
});
test("generated SVG grammar accepts only a bounded embedded PNG raster", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">\n  <image href="data:image/png;base64,${png}" x="0" y="0" width="64" height="64" preserveAspectRatio="xMidYMid meet"/>\n</svg>\n`;
  assert.equal(validateGeneratedSvg(svg), svg);
  assert.throws(() => validateGeneratedSvg(svg.replace("data:image/png", "https://evil.test/image")));
  assert.throws(() => validateGeneratedSvg(svg.replace("<image ", "<image onload=\"alert(1)\" ")));
  const oversized = Buffer.from(png, "base64"); oversized.writeUInt32BE(5_000_000, 16);
  assert.throws(() => validateGeneratedSvg(svg.replace(png, oversized.toString("base64"))), /总像素/);
});
test("local library atomically persists import/selection/removal, rejects bad input and serializes mutations", async t => {
  const dir = await temporary(t), svg = await readFile(new URL("character.svg", sample), "utf8");
  let store = await createCharacterStore(dir);
  assert.equal(store.catalog().selected, "blue-one-eye");
  assert.deepEqual(store.catalog().items.slice(0, 3).map(({ id, name, builtin }) => ({ id, name, builtin })), [
    { id: "blue-one-eye", name: "呼噜呼噜", builtin: true },
    { id: "black-cat", name: "黑猫", builtin: true },
    { id: "sunny-yellow", name: "小太阳", builtin: true },
  ]);
  assert.equal(store.source("sunny-yellow").builtin, true);
  await store.select("black-cat");
  await assert.rejects(store.select("../../bad"));
  await assert.rejects(store.import({name:"",svg}));
  await assert.rejects(store.import({name:"fake",svg:"<svg/>"}));
  const result = await store.import({name:"我的黑猫",svg,analysis});
  const id = result.selected;
  assert.match(id, /^local-/);
  store = await createCharacterStore(dir);
  assert.equal(store.catalog().selected, id);
  assert.equal(store.source().svg, svg);
  assert.equal(store.source().profile.persona.archetype, "proud");
  assert.equal(store.source().analysis.parts[0].kind, "body");
  assert.ok(!JSON.stringify(store.catalog()).includes('<svg'));
  assert.equal("profile" in JSON.parse(await readFile(path.join(dir, "characters-v2.json"), "utf8")).items[0], false);
  const edited = structuredClone(analysis);
  edited.persona.identity = "一只改过名字的黑猫";
  await store.update(id, { name: "改名后的黑猫", analysis: edited });
  assert.equal(store.catalog().items.find(item => item.id === id).name, "改名后的黑猫");
  assert.equal(store.source(id).profile.persona.identity, "一只改过名字的黑猫");
  await assert.rejects(store.update("black-cat", { name: "不能改", analysis }));
  await Promise.all([store.select("black-cat"), store.select("blue-one-eye")]);
  assert.equal(store.catalog().selected, "blue-one-eye");
  await assert.rejects(store.remove("blue-one-eye"));
  await store.select(id); await store.remove(id);
  assert.equal(store.catalog().selected, "blue-one-eye");
  assert.throws(() => store.source(id));
});
test("version 1 local characters reopen with a safe generic profile and migrate on the next write", async t => {
  const dir = await temporary(t), file = path.join(dir, "characters-v1.json"), nextFile = path.join(dir, "characters-v2.json");
  const svg = await readFile(new URL("character.svg", sample), "utf8"), id = "local-12345678-1234-1234-1234-123456789abc";
  await writeFile(file, JSON.stringify({ version: 1, selected: id, items: [{ id, name: "旧角色", svg }] }));
  const store = await createCharacterStore(dir);
  assert.equal(store.source().profile.persona.archetype, "curious");
  assert.equal(store.source().analysis.quality.decision, "warn");
  await store.select("blue-one-eye");
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 1, "legacy data is not overwritten");
  assert.equal(JSON.parse(await readFile(nextFile, "utf8")).version, 2);
});
test("corrupt libraries fall back without overwriting; failed writes preserve the active character", async t => {
  const dir = await temporary(t), file = path.join(dir,"characters-v2.json");
  await writeFile(file, "{broken");
  const corrupt = await createCharacterStore(dir);
  assert.equal(corrupt.source().id,"blue-one-eye");
  assert.ok(corrupt.catalog().warning);
  await assert.rejects(corrupt.select("black-cat"));
  assert.equal(await readFile(file,"utf8"),"{broken");
  const other = path.join(dir,"other");
  const store = await createCharacterStore(other);
  await mkdir(path.join(other,"characters-v2.json.tmp"),{recursive:true});
  await assert.rejects(store.select("black-cat"), /保存失败/);
  assert.equal(store.source().id,"blue-one-eye");
});
