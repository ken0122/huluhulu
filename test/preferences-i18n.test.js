import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CATALOGS, SUPPORTED_LOCALES, brand, t, translationKeys } from "../src/i18n.js";
import { createPreferencesStore, resolveSystemLocale } from "../src/preferences.js";
import { localizedBuiltinProfile, localizedCustomProfile } from "../src/localized-profiles.js";
import { BLACK_CAT_PROFILE, BLUE_ONE_EYE_PROFILE, SUNNY_YELLOW_PROFILE } from "../src/character-profile.js";
import { chatSystemPrompt } from "../src/chat.js";
import { characterDefinition } from "../src/characters.js";

test("system language resolution distinguishes Chinese scripts and falls back to English", () => {
  assert.equal(resolveSystemLocale(["zh-Hant-HK", "en-US"]), "zh-TW");
  assert.equal(resolveSystemLocale(["zh_CN"]), "zh-CN");
  for (const locale of ["en", "ja", "fr", "de", "ru"]) assert.equal(resolveSystemLocale([locale + "-XX"]), locale);
  assert.equal(resolveSystemLocale(["es-ES"]), "en");
});

test("preferences persist atomically while corrupt data falls back without overwrite", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bluepet-preferences-"));
  const file = path.join(directory, "preferences-v1.json");
  await writeFile(file, "not-json");
  const fallback = createPreferencesStore({ directory, systemLanguages: () => ["ja-JP"] });
  assert.deepEqual(fallback.get(), { version: 1, theme: "system", locale: "system", resolvedLocale: "ja", warning: "preferences-invalid" });
  assert.equal(await readFile(file, "utf8"), "not-json");
  assert.equal(fallback.set({ theme: "dark", locale: "fr" }).resolvedLocale, "fr");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1, theme: "dark", locale: "fr" });
});

test("all seven catalogs expose the same keys and placeholders", () => {
  const keys = translationKeys();
  const placeholders = value => [...String(value).matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const locale of SUPPORTED_LOCALES) {
    assert.deepEqual(Object.keys(CATALOGS[locale]).sort(), keys, locale);
    for (const key of keys) assert.deepEqual(placeholders(CATALOGS[locale][key]), placeholders(CATALOGS.en[key]), `${locale}:${key}`);
  }
  assert.equal(brand("zh-CN"), "呼噜呼噜");
  assert.equal(brand("zh-TW"), "呼噜呼噜");
  assert.equal(brand("de"), "Hulu Hulu");
  assert.equal(t("fr", "quit", { brand: brand("fr") }), "Quitter Hulu Hulu");
  assert.match(t("en", "characterImageOperationFailed"), /static PNG or JPEG under 10 MB/);
});

test("built-in profiles localize without mutating the source profile", () => {
  for (const [id, source] of [["blue-one-eye", BLUE_ONE_EYE_PROFILE], ["black-cat", BLACK_CAT_PROFILE], ["sunny-yellow", SUNNY_YELLOW_PROFILE]])
    for (const locale of ["zh-TW", "en", "ja", "fr", "de", "ru"]) {
      const profile = localizedBuiltinProfile(id, source, locale);
      assert.notEqual(profile.persona.identity, source.persona.identity, `${id}:${locale}`);
      assert.ok(profile.reactions.headpat.messages[0]);
    }
  assert.equal(BLUE_ONE_EYE_PROFILE.persona.identity, "住在桌面上的蓝色单眼小宠物");
});

test("custom character bubbles use authored and translated dialogue without mutating saved content", () => {
  const source = structuredClone(BLUE_ONE_EYE_PROFILE);
  source.persona.identity = "用户自己的角色";
  source.reactions.hop.messages = ["用户写的原句"];
  source.idle[0].messages = ["用户写的自言自语"];
  const analysis = { sourceLocale: "zh-CN", dialogueTranslations: { en: { headpat:["Pat pat"],tickle:["Tickles"],poke:["No poking"],cuddle:["Cuddle"],nuzzle:["Snuggle"],hop:["Custom hello"],shy:["A little shy"] } } };
  const chinese = localizedCustomProfile(source, "zh-CN", analysis);
  const english = localizedCustomProfile(source, "en", analysis);
  const japanese = localizedCustomProfile(source, "ja");
  const runtime = characterDefinition("local-test", source, undefined, undefined, "de");
  assert.equal(english.persona.identity, "用户自己的角色");
  assert.equal(chinese.reactions.hop.messages[0], "用户写的原句");
  assert.equal(english.reactions.hop.messages[0], "Custom hello");
  assert.equal(english.idle[0].messages[0], "Looking around…");
  assert.equal(japanese.reactions.hop.messages[0], "用户写的原句");
  assert.equal(japanese.idle[0].messages[0], "きょろきょろ…");
  assert.equal(runtime.profile.reactions.hop.messages[0], "用户写的原句");
  assert.equal(runtime.profile.idle[0].messages[0], "Ich schaue mich um…");
  assert.equal(source.reactions.hop.messages[0], "用户写的原句");
  assert.equal(source.idle[0].messages[0], "用户写的自言自语");
});

test("chat constraints are emitted in the selected interface language", () => {
  assert.match(chatSystemPrompt(BLUE_ONE_EYE_PROFILE.persona, { locale: "ja" }), /ユーザーの言語/);
  assert.match(chatSystemPrompt(BLUE_ONE_EYE_PROFILE.persona, { locale: "fr" }), /langue de l’utilisateur/);
});
