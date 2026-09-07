import { loadChatProvider } from "./chat-provider.js";
import { inspectCharacterImage } from "./character-import.js";
import { CHARACTER_INTENTS, profileFromPersona } from "./character-profile.js";
import { editSourceDialogue, characterText, writeCharacterText, characterTextPatch } from "./character-draft.js";
import sharp from "sharp";
import { CharacterError } from "./character-errors.js";

const DECISIONS = new Set(["pass", "warn", "reject"]);
const ISSUES = new Set([
  "multiple-subjects", "cropped", "busy-background", "low-resolution",
  "occluded", "not-character", "unclear-parts", "side-view",
]);
const PARTS = new Set(["body", "head", "eye", "mouth", "ear", "arm", "leg", "tail", "accessory"]);
const ARCHETYPES = new Set(["shy", "proud", "cheerful", "calm", "curious", "mischievous"]);
const VOICES = new Set(["soft", "reserved", "bright", "steady", "curious", "playful"]);
const LOCALES = Object.freeze(["zh-CN", "zh-TW", "en", "ja", "fr", "de", "ru"]);
const GENERATED_DIALOGUE_MAX = 24;
const TRANSLATED_DIALOGUE_MAX = 50;
const GENERATED_DIALOGUE_COUNT = 4;
const GENERATED_EGG_DESCRIPTION_MAX = 80;
const TRANSLATED_EGG_DESCRIPTION_MAX = 120;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const GENERATION_SCOPES = new Set(["all", "persona", "dialogue", "easterEgg", "parts"]);
const TEXT_REQUIREMENTS = "文字非空、单行；长度按 UTF-16 计，含空格标点。";
const PERSONA_REQUIREMENTS = "name、identity≤40，summary≤80；traits 1–4项，每项≤12。archetype: shy/proud/cheerful/calm/curious/mischievous；voice: soft/reserved/bright/steady/curious/playful。";
const GENERATED_DIALOGUE_REQUIREMENTS = "每句≤24，中文宜4–10字，其他语言宜2–5词。";
const TRANSLATED_DIALOGUE_REQUIREMENTS = "保留每组原有句数和逐句原意，每句≤50，不合并、不拆分、不新增。";
const GENERATED_EGG_REQUIREMENTS = `label≤24，description≤80，message≤50；triggerIntent: ${CHARACTER_INTENTS.join("/")}；不依赖声音或新动作。`;
const TRANSLATED_EGG_REQUIREMENTS = `label≤24，description≤120，message≤50；triggerIntent保持原值；只翻译文字，不创作新机制。`;
const PART_REQUIREMENTS = "只识别真实可见部件，1–24项。kind: body/head/eye/mouth/ear/arm/leg/tail/accessory；confidence: 0–1；box: 图内归一化[x,y,width,height]，宽高>0。";
function scopeRequirements(target, translation = false) {
  const rules = [TEXT_REQUIREMENTS];
  if (["persona", "all"].includes(target.scope)) rules.push(PERSONA_REQUIREMENTS);
  if (["dialogue", "all"].includes(target.scope)) rules.push(translation ? TRANSLATED_DIALOGUE_REQUIREMENTS : `每组恰好 ${GENERATED_DIALOGUE_COUNT} 句不同台词。\n${GENERATED_DIALOGUE_REQUIREMENTS}`);
  if (["easterEgg", "all"].includes(target.scope)) rules.push(translation ? TRANSLATED_EGG_REQUIREMENTS : GENERATED_EGG_REQUIREMENTS);
  return rules.join("\n");
}

class CharacterTextError extends CharacterError {}
class CharacterTextShapeError extends CharacterTextError {
  constructor(message, field) { super("CHAR_INVALID_OUTPUT", message, { field }); }
}
class CharacterReplyError extends CharacterError {}
class CharacterValidationError extends CharacterError {
  constructor(message) { super("CHAR_INVALID_OUTPUT", message); }
}
function fieldCode(label) {
  const fields = { "角色名称":"name", "角色身份":"persona.identity", "角色气质":"persona.summary", "图片质量说明":"quality.explanation", "彩蛋名称":"easterEgg.label", "彩蛋说明":"easterEgg.description", "彩蛋短句":"easterEgg.message" };
  if (fields[label]) return fields[label];
  const trait = /^性格特点 (\d+)$/.exec(label);
  if (trait) return `persona.traits[${trait[1]}]`;
  const line = /^(?:(zh-CN|zh-TW|en|ja|fr|de|ru) )?(headpat|tickle|poke|cuddle|nuzzle|hop|shy) (?:翻译|互动语言) (\d+)$/.exec(label);
  return line ? `${line[1] || "dialogue"}.${line[2]}[${line[3]}]` : "character";
}

function text(value, label, maximum) {
  if (typeof value !== "string" || !value.trim()) throw new CharacterTextError("CHAR_TEXT_EMPTY", `${label}必须是非空文本。`, { field: fieldCode(label) });
  if (/[\x00-\x1f\x7f]/.test(value)) throw new CharacterTextError("CHAR_TEXT_CONTROL", `${label}不能包含换行、制表符或控制字符。`, { field: fieldCode(label) });
  if (value.length > maximum) throw new CharacterTextError("CHAR_TEXT_LONG", `${label}超过 ${maximum} 字符上限（当前 ${value.length}，空格和标点也计入）。`, { field: fieldCode(label), maximum, length: value.length });
  return value.trim();
}
function clipText(value, maximum) {
  let clipped = "";
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value.trim())) {
    if (clipped.length + segment.length > maximum) break;
    clipped += segment;
  }
  return clipped.trimEnd();
}
function unit(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function cleanPart(value, index) {
  if (!value || !PARTS.has(value.kind) || !unit(value.confidence) || !Array.isArray(value.box) || value.box.length !== 4
    || !value.box.every(unit) || value.box[2] <= 0 || value.box[3] <= 0
    || value.box[0] + value.box[2] > 1.001 || value.box[1] + value.box[3] > 1.001) {
    throw new CharacterValidationError(`第 ${index + 1} 个部件格式无效。`);
  }
  return Object.freeze({ kind: value.kind, confidence: value.confidence, box: Object.freeze(value.box.slice()) });
}

// Model output is an untrusted suggestion. Normalize it before renderer, store
// or animation code can consume any field.
function validateCharacterAnalysisWithContext(value, { localized = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !DECISIONS.has(value.quality?.decision)) {
    throw new CharacterValidationError("模型没有返回有效的角色分析。");
  }
  const issues = value.quality.issues;
  if (!Array.isArray(issues) || issues.length > 8 || issues.some(issue => !ISSUES.has(issue))) {
    throw new CharacterValidationError("模型返回了未知的图片问题。");
  }
  const persona = requireObject(value.persona, "角色气质", "persona");
  if (!ARCHETYPES.has(persona.archetype)) throw new CharacterTextShapeError("模型没有返回有效的角色气质类型。", "persona.archetype");
  if (!VOICES.has(persona.voice)) throw new CharacterTextShapeError("模型没有返回有效的角色气质语气。", "persona.voice");
  if (!Array.isArray(persona.traits) || persona.traits.length < 1 || persona.traits.length > 4)
    throw new CharacterTextShapeError("模型没有返回有效的角色气质特点。", "persona.traits");
  if (!Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > 24) {
    throw new CharacterValidationError("模型没有返回有效的部件列表。");
  }
  const cleanPersona = Object.freeze({
    archetype: persona.archetype,
    voice: persona.voice,
    identity: text(persona.identity, "角色身份", 40),
    summary: text(persona.summary, "角色气质", 80),
    traits: Object.freeze(persona.traits.map((trait, index) => text(trait, `性格特点 ${index + 1}`, 12))),
  });
  const fallback = profileFromPersona(cleanPersona), dialogue = {};
  for (const intent of CHARACTER_INTENTS) {
    const messages = value.dialogue?.[intent] || fallback.reactions[intent].messages;
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 4) throw new CharacterValidationError(`模型没有返回有效的 ${intent} 互动语言。`);
    dialogue[intent] = Object.freeze(messages.map((message, index) => text(message, `${intent} 互动语言 ${index + 1}`, 50)));
  }
  const sourceLocale = LOCALES.includes(value.sourceLocale) ? value.sourceLocale : "zh-CN";
  const dialogueTranslations = {};
  for (const locale of LOCALES) {
    const translated = value.dialogueTranslations?.[locale];
    if (!translated) continue;
    if (typeof translated !== "object" || Array.isArray(translated)) throw new CharacterValidationError(`模型没有返回有效的 ${locale} 翻译。`);
    dialogueTranslations[locale] = Object.freeze(Object.fromEntries(CHARACTER_INTENTS.filter(intent => Object.hasOwn(translated, intent)).map(intent => {
      const messages = translated[intent];
      if (!Array.isArray(messages) || messages.length < 1 || messages.length > 4)
        throw new CharacterValidationError(`模型没有返回有效的 ${locale} ${intent} 翻译。`);
      return [intent, Object.freeze(messages.map((message, index) => text(message, `${locale} ${intent} 翻译 ${index + 1}`, 50)))];
    })));
  }
  if (!dialogueTranslations[sourceLocale]) dialogueTranslations[sourceLocale] = Object.freeze(dialogue);
  const suggestedEgg = value.easterEgg || {
    label: fallback.easterEgg.label,
    description: fallback.easterEgg.description,
    triggerIntent: fallback.easterEgg.trigger.intent,
    message: fallback.easterEgg.reaction.messages[0],
  };
  if (!CHARACTER_INTENTS.includes(suggestedEgg.triggerIntent)) throw new CharacterTextShapeError("模型返回的彩蛋触发动作无效。", "easterEgg.triggerIntent");
  const clean = {
    version: 1,
    quality: Object.freeze({
      decision: value.quality.decision,
      issues: Object.freeze([...new Set(issues)]),
      explanation: text(value.quality.explanation, "图片质量说明", 120),
    }),
    persona: cleanPersona,
    dialogue: Object.freeze(dialogue),
    sourceLocale,
    dialogueTranslations: Object.freeze(dialogueTranslations),
    easterEgg: Object.freeze({
      label: text(suggestedEgg.label, "彩蛋名称", 24),
      description: text(suggestedEgg.description, "彩蛋说明", localized ? TRANSLATED_EGG_DESCRIPTION_MAX : GENERATED_EGG_DESCRIPTION_MAX),
      triggerIntent: suggestedEgg.triggerIntent,
      message: text(suggestedEgg.message, "彩蛋短句", 50),
    }),
    parts: Object.freeze(value.parts.map(cleanPart)),
  };
  const textVersions = {};
  for (const locale of LOCALES) {
    if (!Object.hasOwn(value.textVersions || {}, locale)) continue;
    const version = requireObject(value.textVersions[locale], "语言版本");
    const validated = validateCharacterAnalysisWithContext({ ...clean,
      persona: Object.hasOwn(version, "persona") ? requireObject(version.persona, "角色气质", "persona") : clean.persona, easterEgg: Object.hasOwn(version, "easterEgg") ? requireObject(version.easterEgg, "角色彩蛋", "easterEgg") : clean.easterEgg }, { localized: true });
    textVersions[locale] = Object.freeze({
      ...(Object.hasOwn(version, "name") ? { name: generatedName(version.name) } : {}),
      ...(Object.hasOwn(version, "persona") ? { persona: validated.persona } : {}),
      ...(Object.hasOwn(version, "easterEgg") ? { easterEgg: validated.easterEgg } : {}),
    });
  }
  if (value.textLocaleOrder !== undefined && (!Array.isArray(value.textLocaleOrder) || value.textLocaleOrder.length > LOCALES.length || value.textLocaleOrder.some(locale => !LOCALES.includes(locale))))
    throw new CharacterValidationError("角色文字语言顺序无效。");
  return Object.freeze({ ...clean, textVersions: Object.freeze(textVersions),
    textLocaleOrder: Object.freeze([...new Set(value.textLocaleOrder || [])]) });
}

export function validateCharacterAnalysis(value) {
  return validateCharacterAnalysisWithContext(value);
}

function jsonFromReply(reply) {
  const plain = reply.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!plain) throw new CharacterReplyError("CHAR_EMPTY_REPLY", "角色生成接口返回了空正文，未提供角色 JSON。");
  const start = plain.indexOf("{"), end = plain.lastIndexOf("}");
  if (start < 0 || end <= start) throw new CharacterReplyError("CHAR_JSON", "角色生成接口已响应，但未返回完整的角色 JSON。");
  try { return JSON.parse(plain.slice(start, end + 1)); }
  catch { throw new CharacterReplyError("CHAR_JSON", "模型返回的角色分析不是有效 JSON，请重试。"); }
}

function characterReply(data) {
  if (data?.stop_reason === "refusal") throw new CharacterError("CHAR_REFUSAL", "模型拒绝了这次角色生成请求，未生成建议。");
  if (data?.error || !data || (!Array.isArray(data.content) && typeof data.content !== "string")) {
    throw new CharacterError("CHAR_RESPONSE", "角色生成接口返回结构不兼容：缺少 Messages content 正文。");
  }
  // Some Messages-compatible gateways flatten a single text block to a string.
  // Never treat thinking/tool blocks as the model's final answer.
  const reply = typeof data.content === "string" ? data.content : data.content
    .filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text).join("");
  return {
    reply, truncated: data.stop_reason === "max_tokens",
    thinkingOnly: !reply.trim() && Array.isArray(data.content) && data.content.some(block => ["thinking", "redacted_thinking"].includes(block?.type)),
  };
}

function repairTextFields(original, repaired, dialogueCount, { translation = false } = {}) {
  const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const next = structuredClone(object(original));
  repaired = object(repaired);
  const bounded = (value, maximum) => {
    try { return text(value, "", maximum); }
    catch (error) {
      if (error.code !== "CHAR_TEXT_LONG" || typeof value !== "string") throw error;
      return text(clipText(value, maximum), "", maximum);
    }
  };
  const replace = (value, candidate, maximum) => {
    try { return text(value, "", maximum); }
    catch {
      // Give the model one focused chance to rewrite. If that rewrite is still
      // only overlong, enforce the field's own limit locally without splitting
      // an emoji or another grapheme. Missing, multiline and malformed values
      // remain validation errors rather than being invented here.
      for (const option of [candidate, value]) {
        try { return bounded(option, maximum); } catch { /* Try the next supplied value. */ }
      }
      return candidate;
    }
  };
  const fields = (source, candidate, limits) => {
    if (!source) return;
    for (const [key, maximum] of Object.entries(limits)) {
      source[key] = replace(source[key], candidate?.[key], maximum);
    }
  };
  const textObject = (owner, candidate, key, limits) => {
    if (!Object.hasOwn(owner, key) && !Object.hasOwn(candidate, key)) return;
    owner[key] = object(owner[key]);
    fields(owner[key], candidate[key], limits);
  };
  const enumField = (source, candidate, key, allowed) => {
    if (source && !allowed.has(source[key])) source[key] = candidate?.[key];
  };
  const lines = (values, candidate, maximum, count) => {
    if (!Array.isArray(values) || values.length < 1 || values.length > 4 || (count !== undefined && values.length !== count)) return candidate;
    return values.map((line, i) => replace(line, candidate?.[i], maximum));
  };
  fields(next, repaired, { name: 40 });
  fields(next.quality, repaired?.quality, { explanation: 120 });
  textObject(next, repaired, "persona", { identity: 40, summary: 80 });
  enumField(next.persona, repaired.persona, "archetype", ARCHETYPES);
  enumField(next.persona, repaired.persona, "voice", VOICES);
  if (next.persona) next.persona.traits = lines(next.persona.traits, repaired.persona?.traits, 12);
  textObject(next, repaired, "easterEgg", { label: 24,
    description: translation ? TRANSLATED_EGG_DESCRIPTION_MAX : GENERATED_EGG_DESCRIPTION_MAX, message: 50 });
  enumField(next.easterEgg, repaired.easterEgg, "triggerIntent", new Set(CHARACTER_INTENTS));
  const dialogueFields = (dialogue, candidate) => {
    const result = object(dialogue);
    for (const intent of CHARACTER_INTENTS) {
      if (Object.hasOwn(result, intent) || Object.hasOwn(object(candidate), intent))
        result[intent] = lines(result[intent], candidate?.[intent], translation ? TRANSLATED_DIALOGUE_MAX : GENERATED_DIALOGUE_MAX, dialogueCount);
    }
    return result;
  };
  if (next.dialogue || repaired.dialogue) next.dialogue = dialogueFields(next.dialogue, repaired.dialogue);
  if (next.dialogueTranslations || repaired.dialogueTranslations) {
    next.dialogueTranslations = object(next.dialogueTranslations);
    for (const locale of LOCALES) {
      if (next.dialogueTranslations[locale] || repaired.dialogueTranslations?.[locale])
        next.dialogueTranslations[locale] = dialogueFields(next.dialogueTranslations[locale], repaired.dialogueTranslations?.[locale]);
    }
  }
  return next;
}

function textRepairPrompt(original, error, replyFormat, requirements) {
  return `上次结果未通过机器校验：${error.message}
逐项检查并修正当前区块的所有不合规字段：
${requirements}
只改无效或缺失字段；保留其余字段、合法枚举、数组项数和事实。不要解释，不要使用Markdown。
返回${replyFormat}，并在输出前自行逐项复核长度。
待修正JSON：${JSON.stringify(original)}`;
}

async function validatedModelReply(options) {
  try {
    const result = await validateModelAttempts(options);
    return Object.freeze({ ...result, diagnostics: options.send.diagnostics() });
  } catch (error) {
    error.diagnostics = options.send.diagnostics();
    throw error;
  }
}

async function validateModelAttempts({ content, send, validate, decode = jsonFromReply, replyFormat = "完整 JSON", dialogueCount,
  repairRequirements = TEXT_REQUIREMENTS, translation = false }) {
  const result = await send(content);
  const parse = ({ reply, truncated, thinkingOnly, phase }) => {
    // The stop marker describes the provider's token accounting. A complete
    // final JSON object can still be usable; validation below remains mandatory.
    try { return decode(reply, { truncated }); }
    catch (error) {
      if (truncated) throw new CharacterReplyError(thinkingOnly ? "CHAR_THINKING_LIMIT" : "CHAR_TRUNCATED",
        thinkingOnly ? "模型达到输出上限时仍只有思考内容，没有给出台词。" : "角色生成达到输出长度上限，结果被截断，未保存建议。", { phase });
      if (error instanceof CharacterError) error.details = { ...error.details, phase };
      throw error;
    }
  };
  let original;
  try {
    original = parse(result);
    return validate(original);
  } catch (error) {
    if (error instanceof CharacterReplyError) {
      // An empty or incomplete answer cannot support text-only image analysis.
      // Retry the original context once with an independent repair deadline.
      const retried = await send([...content, { type: "text", text: `上次响应未能形成有效结果：${error.message}
直接输出${replyFormat}，无解释。` }], { retry: true, repair: true, reason: error.code });
      return validate(parse(retried));
    }
    if (!(error instanceof CharacterTextError)) throw error;
    // Text-only repair uses the chat model; each stage allows at most one repair.
    const repaired = await send([{ type: "text", text: textRepairPrompt(original, error, replyFormat, repairRequirements) }],
      { repair: true, textRepair: true, reason: error.code });
    return validate(repairTextFields(original, parse(repaired), dialogueCount, { translation }));
  }
}

function generationInstruction(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 300 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new CharacterError("CHAR_INVALID_INPUT", "补充要求不能超过 300 个字符。 ");
  }
  return value.trim();
}

function generatedName(value) {
  return text(value, "角色名称", 40);
}

function generationScope(value) {
  if (GENERATION_SCOPES.has(value)) return { scope: value };
  const match = /^dialogue:(headpat|tickle|poke|cuddle|nuzzle|hop|shy)$/.exec(value || "");
  if (match) return { scope: "dialogue", intent: match[1] };
  throw new CharacterError("CHAR_INVALID_INPUT", "不支持这个自动生成范围。 ");
}

function requireObject(value, label, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (field) throw new CharacterTextShapeError(`模型没有返回有效的${label}。`, field);
    throw new CharacterValidationError(`模型没有返回有效的${label}。`);
  }
  return value;
}

function requireDialogue(value, intents, maximum = GENERATED_DIALOGUE_MAX, count) {
  const dialogue = requireObject(value, "互动台词", "dialogue");
  for (const intent of intents) {
    const messages = dialogue[intent];
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 4) {
      throw new CharacterTextShapeError(`模型没有返回有效的 ${intent} 互动语言。`, `dialogue.${intent}`);
    }
    if (count !== undefined && messages.length !== count) throw new CharacterTextShapeError(`每项自动生成必须恰好 ${count} 句台词，${intent} 返回了 ${messages.length} 句。`, `dialogue.${intent}`);
    messages.forEach((message, index) => text(message, `${intent} 互动语言 ${index + 1}`, maximum));
  }
}

export function mergeGeneratedCharacterFields({ name, analysis, scope, patch, locale = analysis.sourceLocale || "zh-CN", action = "generate" }) {
  const current = validateCharacterAnalysis(analysis), target = generationScope(scope);
  const suggestion = requireObject(patch, "自动生成建议");
  const visible = characterText({ name: generatedName(name), analysis: current }, locale);
  const next = { ...visible, analysis: { ...visible.analysis } };
  if (["all", "persona"].includes(target.scope)) {
    next.name = generatedName(suggestion.name);
    next.analysis.persona = requireObject(suggestion.persona, "角色气质", "persona");
  }
  if (["all", "dialogue"].includes(target.scope)) {
    const intents = target.intent ? [target.intent] : CHARACTER_INTENTS;
    requireDialogue(suggestion.dialogue, intents, action === "translate" ? TRANSLATED_DIALOGUE_MAX : GENERATED_DIALOGUE_MAX);
    next.analysis.dialogue = { ...next.analysis.dialogue,
      ...Object.fromEntries(intents.map(intent => [intent, suggestion.dialogue[intent]])) };
  }
  if (["all", "easterEgg"].includes(target.scope)) next.analysis.easterEgg = requireObject(suggestion.easterEgg, "角色彩蛋", "easterEgg");
  if (target.scope === "parts") {
    if (!Array.isArray(suggestion.parts)) throw new CharacterValidationError("模型没有返回有效的互动部件。");
    next.analysis.parts = suggestion.parts;
  }
  // Validate generated fields even when they are stored as a non-source version.
  next.analysis = validateCharacterAnalysisWithContext(next.analysis, { localized: action === "translate" });
  const merged = writeCharacterText({ name, analysis: current }, locale, characterTextPatch(next, scope), { force: true });
  return Object.freeze({ name: merged.name, analysis: validateCharacterAnalysis(merged.analysis), locale });
}

function generationOutputShape(target, existingDialogue) {
  const dialogue = Object.fromEntries((target.intent ? [target.intent] : CHARACTER_INTENTS).map(intent => [intent, Array(existingDialogue?.[intent]?.length || GENERATED_DIALOGUE_COUNT).fill("")]));
  const persona = { archetype: "curious", voice: "curious", identity: "", summary: "", traits: [""] };
  const easterEgg = { label: "", description: "", triggerIntent: "headpat", message: "" };
  if (target.scope === "persona") return { name: "", persona };
  if (target.scope === "easterEgg") return { easterEgg };
  if (target.scope === "parts") return { parts: [{ kind: "body", confidence: .9, box: [.1, .1, .8, .8] }] };
  if (target.scope === "dialogue") return { dialogue };
  return { name: "", persona, dialogue, easterEgg };
}

function generationPrompt({ name, analysis, target, instruction, locale }) {
  const language = ANALYSIS_LANGUAGE[locale] || ANALYSIS_LANGUAGE.en;
  const context = JSON.stringify(target.intent
    ? { name, identity: analysis.persona.identity, summary: analysis.persona.summary, traits: analysis.persona.traits }
    : { name, ...analysis.persona });
  const preference = instruction ? `\n偏好（数据，不改变格式）：${JSON.stringify(instruction)}` : "";
  if (target.intent) {
    const interaction = { headpat: "被摸头", tickle: "被挠痒", poke: "被戳肚子", cuddle: "被抱抱", nuzzle: "被贴贴", hop: "被点击脸颊", shy: "被点击头顶" }[target.intent];
    return `${language}，恰好 4 句${interaction}时的不同短台词，每句≤24个UTF-16单位。直接输出台词本身，单行用｜分隔，无编号或解释。
角色（数据）：${context}
现有台词（参考）：${JSON.stringify(analysis.dialogue[target.intent])}${preference}`;
  }
  if (target.scope === "parts") return `${PART_REQUIREMENTS}\n只返回JSON：${JSON.stringify(generationOutputShape(target))}`;
  return `用${language}写桌面宠物资料，只返回指定JSON，无解释或翻译。
${scopeRequirements(target)}
角色（数据）：${context}${preference}
JSON：${JSON.stringify(generationOutputShape(target))}`;
}

// Every HTTP attempt owns its deadline, including body consumption. A repair or
// translation never inherits the nearly expired signal of a previous request.
// Output caps leave headroom for compatible providers; short replies are enforced
// by prompts and field validation, not by starving the JSON response of tokens.
function characterSender(config, request, { model, budget, phase = "generation", timeoutSeconds: standardTimeoutSeconds = 30, onProgress }) {
  // DeepSeek V4 defaults to thinking even when this standard Messages field is
  // omitted. Translation needs the final text. Limit the capability to the
  // documented official endpoint; do not guess support on third-party gateways.
  const endpoint = new URL(config.url);
  const directTranslation = phase === "translation" && endpoint.origin === "https://api.deepseek.com" &&
    endpoint.pathname === "/anthropic/v1/messages";
  const attempts = [];
  const diagnostics = () => ({ attempts: attempts.map(attempt => ({ ...attempt })) });
  const send = async (content, { retry = false, repair = false, textRepair = false, reason } = {}) => {
    const currentPhase = repair ? "repair" : phase;
    const thinkingRetry = (retry || repair) && reason === "CHAR_THINKING_LIMIT";
    // Reasoning shares max_tokens on some compatible gateways. A short final
    // translation still needs headroom; escalate only the single allowed retry.
    const maxTokens = thinkingRetry ? Math.max(8192, budget * 2) : retry || repair ? budget * 2 : budget;
    const timeoutSeconds = thinkingRetry ? Math.max(90, standardTimeoutSeconds) : standardTimeoutSeconds;
    onProgress?.(currentPhase, { ...diagnostics(), ...(thinkingRetry ? { timeoutSeconds } : {}) });
    const started = performance.now();
    try {
      const response = await request(config.url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutSeconds * 1000),
        headers: { "content-type": "application/json", "x-api-key": config.key, "authorization": `Bearer ${config.key}`, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: textRepair ? config.model : model, max_tokens: maxTokens,
          ...(directTranslation ? { thinking: { type: "disabled" } } : {}), messages: [{ role: "user", content }] }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new CharacterError("CHAR_AUTH", "API 凭证暂不可用，无法生成角色资料。");
        if (response.status === 429) throw new CharacterError("CHAR_RATE", "自动生成请求较多，请稍后再试。");
        throw new CharacterError("CHAR_HTTP", "接口暂时无法生成角色资料，请稍后再试。", { status: response.status });
      }
      return { ...characterReply(await response.json()), phase };
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        const code = repair ? "CHAR_REPAIR_TIMEOUT" : phase === "translation" ? "CHAR_TRANSLATION_TIMEOUT" : "CHAR_TIMEOUT";
        throw new CharacterError(code, repair ? `格式修正超过 ${timeoutSeconds} 秒，请重试。` : phase === "translation" ? `互动翻译超过 ${timeoutSeconds} 秒，请重试。` : `角色生成超过 ${timeoutSeconds} 秒，请重试。`, { timeoutSeconds });
      }
      if (error instanceof TypeError) throw new CharacterError("CHAR_NETWORK", "暂时连不上接口，无法生成角色资料。");
      if (error instanceof SyntaxError) throw new CharacterError("CHAR_UNREADABLE", "接口返回的生成结果暂时无法读取，请重试。");
      throw error;
    } finally {
      attempts.push({ phase: currentPhase, durationMs: Math.max(0, Math.round(performance.now() - started)), ...(reason ? { reason } : {}) });
    }
  };
  send.diagnostics = diagnostics;
  return send;
}

function translationPrompt(entry, target, scope, locale) {
  const single = target.intent && entry.analysis.dialogue[target.intent].length === 1;
  return `翻译成${ANALYSIS_LANGUAGE[locale]}，保留原意和口吻，不创作新情节，不改变枚举。
${single ? `直接输出翻译后的一句台词，无解释或引号。${TEXT_REQUIREMENTS}${TRANSLATED_DIALOGUE_REQUIREMENTS}` : `${scopeRequirements(target, true)}\n只返回JSON：${JSON.stringify(generationOutputShape(target, entry.analysis.dialogue))}`}
原文（数据）：${JSON.stringify(characterTextPatch(entry, scope))}`;
}

// The saved baseline comes from the main-process store, never from renderer input.
// Incomplete edits are kept in the editor, but are not needed to generate a field.
function generationContext({ name, analysis, saved }) {
  let current = validateCharacterAnalysis(saved?.analysis || analysis);
  if (saved && analysis && typeof analysis === "object") {
    try { current = validateCharacterAnalysis(analysis); } catch { /* Recover valid individual sections below. */ }
    for (const key of ["persona", "easterEgg", "parts", "dialogueTranslations", "textVersions", "textLocaleOrder"]) {
      if (!Object.hasOwn(analysis, key)) continue;
      try { current = validateCharacterAnalysis({ ...current, [key]: analysis[key] }); }
      catch { /* Keep the last valid saved section as context. */ }
    }
    for (const intent of CHARACTER_INTENTS) {
      if (!Object.hasOwn(analysis.dialogue || {}, intent)) continue;
      try {
        requireDialogue(analysis.dialogue, [intent], 50);
        current = validateCharacterAnalysis({ ...current, ...editSourceDialogue(current, { ...current.dialogue, [intent]: analysis.dialogue[intent] }) });
      } catch { /* An empty target is precisely what generation can fill. */ }
    }
  }
  let safeName;
  try { safeName = generatedName(name); }
  catch (error) { if (!saved) throw error; safeName = generatedName(saved.name); }
  return { current, safeName };
}

export async function generateCharacterFields({ svg, name, analysis, saved, scope, instruction, action = "generate" }, { provider = loadChatProvider, request = fetch, onProgress, locale } = {}) {
  const target = generationScope(scope);
  if (!["generate", "translate"].includes(action) || (action === "translate" && target.scope === "parts"))
    throw new CharacterError("CHAR_INVALID_INPUT", "不支持这个文字操作。");
  const { current, safeName } = generationContext({ name, analysis, saved });
  const language = LOCALES.includes(locale) ? locale : current.sourceLocale;
  // Retranslation always starts from the canonical source version. Otherwise a
  // generated target-language version would be translated into the same language.
  const contextLanguage = action === "translate" ? current.sourceLocale || "zh-CN" : language;
  const context = characterText({ name: safeName, analysis: current }, contextLanguage);
  const preference = generationInstruction(instruction), config = await provider();
  const visual = target.scope === "parts";
  const content = [{ type: "text", text: action === "translate" ? translationPrompt(context, target, scope, language)
    : generationPrompt({ ...context, target, instruction: preference, locale: language }) }];
  if (visual) {
    if (typeof svg !== "string" || !svg.trim()) throw new CharacterError("CHAR_INVALID_INPUT", "找不到可分析的角色图片。");
    const png = await sharp(Buffer.from(svg), { density: 192 }).resize(512, 512, { fit: "contain" }).png().toBuffer();
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } });
  }
  const singleLine = target.intent && (action === "generate" || context.analysis.dialogue[target.intent].length === 1) ? {
    replyFormat: action === "generate" ? "恰好 4 句台词，用全角｜分隔" : "一句台词",
    decode: (reply, { truncated }) => {
      const plain = reply.trim();
      if (plain.startsWith("{") || plain.startsWith("```")) return jsonFromReply(plain);
      if (!plain || truncated) throw new CharacterReplyError("CHAR_EMPTY_REPLY", "模型返回空正文或不完整台词。");
      return { dialogue: { [target.intent]: action === "generate" ? plain.split(/[｜|]/).map(line => line.trim()) : [plain] } };
    },
  } : {};
  return validatedModelReply({ content, ...singleLine, dialogueCount: action === "generate" ? GENERATED_DIALOGUE_COUNT : undefined,
    translation: action === "translate", repairRequirements: scopeRequirements(target, action === "translate"),
    send: characterSender(config, request, { model: visual ? config.visionModel || config.model : config.model,
      budget: visual ? 2200 : target.scope === "all" ? 4096 : 2048,
      // A complete profile contains seven four-line interaction groups plus
      // persona and easter-egg fields. Compatible gateways can need more than
      // 30 seconds to return and stream that larger response.
      timeoutSeconds: !visual && action === "generate" && target.scope === "all" ? 90 : 30,
      phase: action === "translate" ? "translation" : "generation", onProgress }),
    validate: patch => {
      if (action === "generate" && ["all", "dialogue"].includes(target.scope))
        requireDialogue(patch?.dialogue, target.intent ? [target.intent] : CHARACTER_INTENTS, GENERATED_DIALOGUE_MAX, GENERATED_DIALOGUE_COUNT);
      if (action === "translate" && ["all", "dialogue"].includes(target.scope)) {
        for (const intent of target.intent ? [target.intent] : CHARACTER_INTENTS) {
          if (Array.isArray(patch?.dialogue?.[intent]) && patch.dialogue[intent].length !== context.analysis.dialogue[intent].length)
            throw new CharacterReplyError("CHAR_INVALID_OUTPUT", `翻译必须保留 ${intent} 的全部 ${context.analysis.dialogue[intent].length} 句台词。`, { field: `dialogue.${intent}` });
        }
      }
      if (action === "translate") {
        // Translation never changes interaction mechanics or personality enums.
        if (patch.persona) patch.persona = { ...patch.persona, archetype: context.analysis.persona.archetype, voice: context.analysis.persona.voice };
        if (patch.easterEgg) patch.easterEgg = { ...patch.easterEgg, triggerIntent: context.analysis.easterEgg.triggerIntent };
      }
      return mergeGeneratedCharacterFields({ name: safeName, analysis: current, scope, patch, locale: language, action });
    },
  });
}

const ANALYSIS_PROMPT = `分析这张桌面宠物图片，只返回JSON。
要求：单个完整角色、无裁切，透明或纯色背景，正面或轻微侧面，部件清晰。
quality.decision: pass/warn/reject；issues: multiple-subjects/cropped/busy-background/low-resolution/occluded/not-character/unclear-parts/side-view；explanation≤120。
${scopeRequirements({ scope: "all" })}
${PART_REQUIREMENTS}清晰眼睛分别给eye框，无法分开时才合框，不框整脸。
只用目标语言，不生成任何翻译。
JSON：${JSON.stringify({ quality: { decision: "pass", issues: [], explanation: "" }, ...generationOutputShape({ scope: "all" }), ...generationOutputShape({ scope: "parts" }) })}`;
const ANALYSIS_LANGUAGE = { "zh-CN":"简体中文", "zh-TW":"繁体中文", en:"English", ja:"日本語", fr:"français", de:"Deutsch", ru:"русский язык" };

export async function analyzeCharacterImage({ bytes, mime }, { provider = loadChatProvider, request = fetch, locale = "zh-CN" } = {}) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const info = inspectCharacterImage(source);
  if (mime !== info.mime) throw new CharacterValidationError("图片类型与文件内容不一致。");
  const config = await provider();
  return await validatedModelReply({
      dialogueCount: GENERATED_DIALOGUE_COUNT,
      repairRequirements: scopeRequirements({ scope: "all" }),
      content: [
        { type: "text", text: ANALYSIS_PROMPT + `\n所有面向用户的文字字段只使用${ANALYSIS_LANGUAGE[locale] || ANALYSIS_LANGUAGE.en}。` },
        { type: "image", source: { type: "base64", media_type: info.mime, data: Buffer.from(source).toString("base64") } },
      ],
      send: characterSender(config, request, { model: config.visionModel || config.model, budget: 6144 }),
      validate: patch => {
        requireDialogue(patch?.dialogue, CHARACTER_INTENTS, GENERATED_DIALOGUE_MAX, GENERATED_DIALOGUE_COUNT);
        requireObject(patch?.easterEgg, "角色彩蛋", "easterEgg");
        return validateCharacterAnalysis({ ...patch, sourceLocale: locale, dialogueTranslations: {}, textVersions: {}, textLocaleOrder: [locale] });
      },
    });
}
