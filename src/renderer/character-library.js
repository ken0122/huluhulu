import { characterTimingMessage } from "../character-timing.js";
import { BLUE_ONE_EYE, BLACK_CAT, SUNNY_YELLOW, characterDefinition } from "../characters.js";
import { validateGeneratedSvg } from "../character-import.js";
import { profileFromAnalysis } from "../character-profile.js";
import { characterText, writeCharacterText, characterTextPatch } from "../character-draft.js";
import { mapPartBox } from "../character-vectorize.js";
import { mountCharacter } from "./character.js";
import { deriveImportedEyeRig } from "./imported-eye-rig.js";
import { appBrand, installLocalization, localizeDocument, localizedError, tr } from "./localize.js";

const $ = selector => document.querySelector(selector), api = window.characterLibrary;
let catalog, selected, previewEntry, draft, characters = [], busy = false, paused = false, previewGait = "idle", reactionTimer, worker, originalUrl, generationAnchor;
const displayName = item => item?.builtin ? tr(({"blue-one-eye":"characterBlue","black-cat":"characterBlack","sunny-yellow":"characterSunny"})[item.id]) : item?.names?.[document.documentElement.lang] || item?.name;
function status(message, error = false, action = false) {
  $("#status-text").textContent = action ? "" : message;
  $("#status-action").textContent = action ? message : "";
  $("#status-action").hidden = !action;
  $("#status").dataset.error = String(error);
  if (error) $("#status").scrollIntoView({ block: "nearest" });
}
async function request(promise) {
  const result = await promise;
  if (!result.ok) { const error = new Error(result.error); error.code = result.code; error.details = result.details; error.diagnostics = result.diagnostics; throw error; }
  return result.value;
}
function controls() {
  const importing = draft?.mode === "import", editing = draft?.mode === "edit";
  document.querySelectorAll("button:not(#close)").forEach(button => {
    button.disabled = busy || button.dataset.translateUnavailable === "true";
  });
  $("#motions").disabled = busy || !characters.length;
  $("#apply").disabled = busy || !selected || Boolean(draft?.blocked) || (!draft && selected.id === catalog?.selected);
  const current = !draft && selected?.id === catalog?.selected;
  $("#apply").textContent = tr(importing ? "addAndUse" : editing ? "saveChanges" : current ? "currentUse" : "useCharacter");
  $("#apply").classList.toggle("is-current", current);
  $("#remove").hidden = !selected || selected.builtin || Boolean(draft);
  $("#edit").hidden = !selected || selected.builtin || Boolean(draft);
  $("#cancel").hidden = !draft;
  $("#cancel").textContent = tr(editing ? "cancelEdit" : "discardAdd");
  $("#choose").textContent = tr(importing ? "changeImage" : "addCharacter");
  $("#generation-tools").hidden = !editing;
  $("#generation-proposal").hidden = !editing || !draft?.proposal;
  $("#character-name").disabled = busy;
  document.body.setAttribute("aria-busy", String(busy));
  // Keep live generation feedback accessible while preventing edits.
  document.querySelectorAll("#draft-fields input, #draft-fields textarea, #draft-fields select").forEach(field => { field.disabled = busy; });
  $("#draft-fields").setAttribute("aria-busy", String(busy));
}
async function operation(fn, fallbackKey = "characterOperationFailed") {
  if (busy) return;
  busy = true; controls();
  try { await fn(); }
  catch (error) {
    if (error.code === "PROVIDER_NOT_CONFIGURED") status(tr("providerMissingAction"), true, true);
    else status(localizedError(error, fallbackKey), true);
  }
  finally { busy = false; controls(); }
}
function renderCatalog() {
  $("#catalog").replaceChildren(...catalog.items.map(item => {
    const button = document.createElement("button"); button.className = "entry"; button.dataset.id = item.id;
    button.setAttribute("aria-pressed", String(!draft && selected?.id === item.id));
    const top = document.createElement("span"); top.className = "entry__top";
    const name = document.createElement("span"); name.textContent = displayName(item); top.append(name);
    if (item.id === catalog.selected) { const current = document.createElement("span"); current.className = "current-badge"; current.textContent = tr("current"); top.append(current); }
    const detail = document.createElement("small"); detail.textContent = tr(item.builtin ? "builtin" : "added");
    button.append(top, detail);
    button.addEventListener("click", () => operation(async () => {
      if (draft && !confirm(tr("discardView"))) return;
      if (draft) api.setDirty(false);
      await showEntry(item);
    }));
    return button;
  }));
}
function clearOriginal() { if (originalUrl) URL.revokeObjectURL(originalUrl); originalUrl = undefined; $("#original-slot").replaceChildren(); $("#original").hidden = true; }
const PART_KEYS = { body:"body",head:"head",eye:"eye",mouth:"mouth",ear:"ear",arm:"arm",leg:"leg",tail:"tail",accessory:"accessory" };
const INTERACTION_KEYS = { headpat:"headpat",tickle:"tickle",poke:"poke",cuddle:"cuddle",nuzzle:"nuzzle",hop:"clickFace",shy:"clickHead" };
function partRow(part = { kind: "accessory", confidence: 1, box: [.25,.25,.5,.5] }) {
  const row = document.createElement("div"); row.className = "part-row";
  row.dataset.confidence = String(part.confidence);
  row.addEventListener("input", () => { row.dataset.confidence = "1"; });
  const kind = document.createElement("select"); kind.setAttribute("aria-label", tr("partType"));
  for (const [value, key] of Object.entries(PART_KEYS)) {
    const option = document.createElement("option"); option.value = value; option.textContent = tr(key); kind.append(option);
  }
  kind.value = part.kind;
  row.append(kind, ...part.box.map((value, index) => {
    const input = document.createElement("input"); input.type = "number"; input.min = "0"; input.max = "1"; input.step = "any"; input.value = String(value);
    input.setAttribute("aria-label", tr(["left", "top", "width", "height"][index])); return input;
  }));
  const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×";
  remove.setAttribute("aria-label", tr("removePart", { part: tr(PART_KEYS[part.kind] || "parts") })); remove.addEventListener("click", () => row.remove()); row.append(remove);
  return row;
}
const currentLocale = () => document.documentElement.lang || "zh-CN";
const languageName = locale => new Intl.DisplayNames([currentLocale()], { type: "language" }).of(({ "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" })[locale] || locale);
function localGenerationStatus(message, error = false) {
  $("#generation-result").hidden = false;
  $("#generation-status").textContent = message;
  $("#generation-settings").hidden = true;
  $("#generation-status").dataset.error = String(error);
}
function placeGenerationResult(scope) {
  const button = document.querySelector(`[data-generate-scope="${scope}"]`);
  if (!button) return;
  generationAnchor = scope;
  const field = button.closest(".dialogue-label");
  if (field) field.append($("#generation-result"));
  else button.closest(".generation-heading, .editor-section-heading, .dialogue-heading, .parts-heading").after($("#generation-result"));
}
function renderDraft() {
  const view = characterText(draft, draft.locale);
  const translated = draft.locale !== (draft.analysis.sourceLocale || "zh-CN");
  $("#egg-description").maxLength = translated ? 120 : 80;
  $("#character-name").value = view.name;
  $("#personality").textContent = view.analysis.persona.traits.join(" · ");
  $("#easter-egg").textContent = tr("qualityEgg", { name: view.analysis.easterEgg.label });
  $("#capabilities").textContent = tr("capabilityAnalyzed", { count: view.analysis.parts.length });
  renderAnalysis(view.analysis);
  $("#text-language-hint").textContent = tr("characterTextLanguage", { language: languageName(draft.locale) });
}
function renderAnalysis(analysis) {
  // Preserve the live result and its event handlers when rebuilding input rows.
  $("#draft-fields").prepend($("#generation-result"));
  const labels = { pass: tr("materialPass"), warn: tr("materialWarn"), reject: tr("materialReject") };
  $(".analysis-heading").dataset.decision = analysis.quality.decision;
  $(".analysis-heading").hidden = analysis.quality.decision === "pass";
  $("#quality-label").textContent = labels[analysis.quality.decision];
  $("#quality-explanation").textContent = analysis.quality.explanation;
  $("#persona-identity").value = analysis.persona.identity;
  $("#persona-archetype").value = analysis.persona.archetype;
  $("#persona-voice").value = analysis.persona.voice;
  $("#persona-summary").value = analysis.persona.summary;
  $("#persona-traits").value = analysis.persona.traits.join("、");
  $("#dialogue-list").replaceChildren(...Object.entries(INTERACTION_KEYS).map(([intent, key]) => {
    const field = document.createElement("div"); field.className = "dialogue-label";
    const heading = document.createElement("div"), title = document.createElement("label"); title.textContent = tr(key); title.htmlFor = `dialogue-${intent}`;
    heading.className = "dialogue-field-heading";
    const actions = document.createElement("div"); actions.className = "text-actions";
    const generate = document.createElement("button"); generate.type = "button"; generate.dataset.generateScope = `dialogue:${intent}`; generate.textContent = tr("generateGroup");
    const translate = document.createElement("button"); translate.type = "button"; translate.dataset.translateScope = `dialogue:${intent}`;
    actions.append(generate, translate); heading.append(title, actions);
    const input = document.createElement("textarea"); input.id = title.htmlFor; input.dataset.dialogue = intent; input.maxLength = 203; input.rows = 3; input.value = analysis.dialogue[intent].join("｜");
    field.append(heading, input); return field;
  }));
  $("#egg-label").value = analysis.easterEgg.label;
  $("#egg-trigger").value = analysis.easterEgg.triggerIntent;
  $("#egg-description").value = analysis.easterEgg.description;
  $("#egg-message").value = analysis.easterEgg.message;
  $("#parts-list").replaceChildren(...analysis.parts.map(partRow));
  document.querySelectorAll("[data-translate-scope]").forEach(button => {
    const locale = draft?.locale || currentLocale();
    button.textContent = tr("translateCurrent");
    button.hidden = false;
    button.dataset.translateUnavailable = String(locale === (draft?.analysis.sourceLocale || "zh-CN"));
  });
  if (generationAnchor) placeGenerationResult(generationAnchor);
}

function generatedScopeName(scope) {
  if (scope === "all") return tr("allFields");
  if (scope === "persona") return tr("basicInfo");
  if (scope === "dialogue") return tr("dialogue");
  if (scope === "easterEgg") return tr("easterEgg");
  if (scope === "parts") return tr("parts");
  const intent = scope?.split(":")[1];
  return tr(INTERACTION_KEYS[intent] || "dialogue");
}
function proposalRow(label, before, after) {
  const item = document.createElement("li"), key = document.createElement("strong"), value = document.createElement("span");
  key.textContent = label; value.textContent = after; item.append(key, value); return item;
}
function renderProposal() {
  const proposal = draft?.proposal;
  $("#generation-proposal").hidden = !proposal;
  if (!proposal) { $("#generation-diff").replaceChildren(); return; }
  const edited = editedEntry(), current = characterText(edited, proposal.locale).analysis, nextEntry = characterText(proposal, proposal.locale), next = nextEntry.analysis, scope = proposal.scope;
  $("#proposal-title").textContent = tr("suggestionTitle", { section: generatedScopeName(scope) }) + ` · ${languageName(proposal.locale)}`;
  const rows = [];
  if (["all", "persona"].includes(scope)) {
    rows.push(
      proposalRow(tr("characterName"), $("#character-name").value, nextEntry.name),
      proposalRow(tr("identity"), current.persona.identity, next.persona.identity),
      proposalRow(tr("archetype"), tr(current.persona.archetype), tr(next.persona.archetype)),
      proposalRow(tr("voice"), tr(current.persona.voice), tr(next.persona.voice)),
      proposalRow(tr("summary"), current.persona.summary, next.persona.summary),
      proposalRow(tr("traits"), current.persona.traits.join(" · "), next.persona.traits.join(" · ")),
    );
  }
  if (scope === "all" || scope === "dialogue" || scope?.startsWith("dialogue:")) {
    const intents = scope?.startsWith("dialogue:") ? [scope.split(":")[1]] : Object.keys(INTERACTION_KEYS);
    for (const intent of intents) rows.push(proposalRow(tr(INTERACTION_KEYS[intent]), current.dialogue[intent].join("｜"), next.dialogue[intent].join("｜")));
  }
  if (["all", "easterEgg"].includes(scope)) {
    rows.push(
      proposalRow(tr("eggName"), current.easterEgg.label, next.easterEgg.label),
      proposalRow(tr("eggDescription"), current.easterEgg.description, next.easterEgg.description),
      proposalRow(tr("eggTrigger"), tr(INTERACTION_KEYS[current.easterEgg.triggerIntent]), tr(INTERACTION_KEYS[next.easterEgg.triggerIntent])),
      proposalRow(tr("eggLine"), current.easterEgg.message, next.easterEgg.message),
    );
  }
  if (scope === "parts") {
    const describe = parts => parts.map(part => `${tr(PART_KEYS[part.kind])} ${part.box.map(value => value.toFixed(2)).join("/")}`).join(" · ");
    rows.push(proposalRow(tr("parts"), describe(current.parts), describe(next.parts)));
  }
  $("#generation-diff").replaceChildren(...rows);
}

let generationDiagnostics, generationRepairing = false;
function renderGenerationTiming(diagnostics = generationDiagnostics, repairing = generationRepairing) {
  generationDiagnostics = diagnostics; generationRepairing = repairing;
  const message = characterTimingMessage(currentLocale(), diagnostics, repairing);
  $("#generation-timing").textContent = message;
  $("#generation-timing").hidden = !message;
}

async function generateSuggestion(scope, action = "generate") {
  if (draft?.mode !== "edit" || busy) return;
  const entry = editedEntry();
  draft.name = entry.name; draft.analysis = entry.analysis;
  draft.proposal = undefined; renderProposal(); placeGenerationResult(scope);
  generationDiagnostics = undefined; renderGenerationTiming(undefined, false);
  await operation(async () => {
    localGenerationStatus(tr(action === "translate" ? "translatingCurrent" : "generatingSuggestion"));
    try {
      const result = await request(api.generate({ id: draft.id, ...entry, scope, action,
        instruction: $("#generation-instruction").value }));
      draft.proposal = { ...result, scope, action };
      renderGenerationTiming(result.diagnostics, false);
      renderProposal(); placeGenerationResult(scope);
      localGenerationStatus("");
      $("#generation-proposal").scrollIntoView({ block: "nearest" });
    } catch (error) {
      renderGenerationTiming(error.diagnostics, false);
      localGenerationStatus(localizedError(error, "characterOperationFailed"), true);
      $("#generation-settings").hidden = error.code !== "PROVIDER_NOT_CONFIGURED";
      $("#generation-status").scrollIntoView({ block: "nearest" });
    }
  });
}

function adoptGeneratedFields(proposal) {
  return writeCharacterText(editedEntry(), proposal.locale,
    characterTextPatch(characterText(proposal, proposal.locale), proposal.scope), { force: true });
}
function editedEntry() {
  return writeCharacterText(draft, draft.locale, { name: $("#character-name").value, ...editedAnalysis() });
}
function editedAnalysis() {
  const traits = $("#persona-traits").value.split(/[、,，]/).map(value => value.trim()).filter(Boolean);
  const parts = Array.from(document.querySelectorAll(".part-row"), row => ({
    kind: row.querySelector("select").value,
    confidence: Number(row.dataset.confidence),
    box: Array.from(row.querySelectorAll("input"), input => Number(input.value)),
  }));
  const dialogue = Object.fromEntries(Array.from(document.querySelectorAll("[data-dialogue]"), input => [
    input.dataset.dialogue,
    input.value.split(/[｜|]/).map(value => value.trim()).filter(Boolean),
  ]));
  return {
    ...draft.analysis,
    persona: {
      archetype: $("#persona-archetype").value,
      voice: $("#persona-voice").value,
      identity: $("#persona-identity").value,
      summary: $("#persona-summary").value,
      traits,
    },
    dialogue,
    easterEgg: { label: $("#egg-label").value, triggerIntent: $("#egg-trigger").value, description: $("#egg-description").value, message: $("#egg-message").value },
    parts,
  };
}
async function mount(entry) {
  if (!entry.builtin) validateGeneratedSvg(entry.svg);
  const parsed = new DOMParser().parseFromString(entry.svg, "image/svg+xml");
  if (parsed.querySelector("parsererror")) throw new Error("SVG 无法读取，请重新导入。");
  const eyeRig = entry.builtin ? null : await deriveImportedEyeRig(entry.svg, entry.analysis?.parts);
  const definition = characterDefinition(entry.id, entry.profile, entry.analysis, eyeRig, document.documentElement.lang);
  const { persona, easterEgg } = definition.profile;
  clearTimeout(reactionTimer);
  characters = Array.from(document.querySelectorAll(".character-host"), host => mountCharacter(host, document.importNode(parsed.documentElement, true), definition, { eyelids: host.id !== "game" }));
  paused = false; previewGait = "idle"; $("#pause").textContent = tr("pausePreview"); $("#pause").setAttribute("aria-pressed", "false");
  document.querySelectorAll("[data-gait]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.gait === "idle")));
  $("#personality").textContent = persona.traits.join(" · ");
  $("#easter-egg").textContent = tr("qualityEgg", { name: easterEgg.label });
  $("#egg-preview").dataset.reaction = easterEgg.reaction.motion;
  $("#egg-preview").dataset.duration = String(easterEgg.reaction.duration);
  $("#capabilities").textContent = entry.id === BLUE_ONE_EYE.id ? tr("capabilityBlue") : entry.id === BLACK_CAT.id ? tr("capabilityBlack") : entry.id === SUNNY_YELLOW.id ? tr("capabilitySunny") : entry.analysis ? tr("capabilityAnalyzed", { count: entry.analysis.parts.length }) : tr("capabilityGeneric");
}
async function showEntry(item) {
  const entry = await request(api.source(item.id));
  await mount(entry); selected = item; previewEntry = entry; draft = undefined; generationAnchor = undefined; $("#generation-result").hidden = true; clearOriginal();
  $("#draft-fields").hidden = true; $("#art-caption").hidden = true; $("#name").textContent = displayName(item);
  $("#selection-status").textContent = item.id === catalog.selected ? tr("currentCharacter") : tr("previewing", { name: displayName(catalog.items.find(entry => entry.id === catalog.selected)) });
  renderCatalog();
  status(catalog.warning || "", Boolean(catalog.warning));
}
function convert(bytes) {
  return new Promise((resolve, reject) => {
    const task = worker = new Worker(new URL("./character-convert-worker.js", import.meta.url), { type: "module" });
    const timer = setTimeout(() => finish(new Error("转换超时，请使用更小、更简洁的图片。")), 10000);
    function finish(error, result) { clearTimeout(timer); task.terminate(); if (worker === task) worker = undefined; error ? reject(error) : resolve(result); }
    task.onmessage = ({data}) => finish(data.ok ? null : new Error(data.error), data);
    task.onerror = event => { event.preventDefault(); finish(new Error("图片转换失败，请重新导出 PNG/JPG 后重试。")); };
    task.postMessage(bytes);
  });
}
$("#choose").addEventListener("click", () => operation(async () => {
  if (draft && !confirm(tr("discardImport"))) return;
  const input = await request(api.choose());
  if (!input) return;
  status(tr("processing"));
  const [conversion, rawAnalysis] = await Promise.all([
    convert(input.bytes),
    request(api.analyze({ bytes: input.bytes, mime: input.mime })),
  ]);
  const svg = conversion.svg;
  const analysis = {
    ...rawAnalysis,
    parts: rawAnalysis.parts.map(part => ({ ...part, box: mapPartBox(part.box, input.width, input.height, conversion.transform) })),
  };
  const profile = profileFromAnalysis(analysis);
  await mount({ id: "draft", svg, profile, analysis, builtin: false });
  draft = { mode: "import", locale: currentLocale(), svg, name: input.name, analysis, blocked: analysis.quality.decision === "reject" };
  selected = { id: "draft", name: input.name, builtin: false };
  clearOriginal(); originalUrl = URL.createObjectURL(new Blob([input.bytes], { type: input.mime }));
  const image = new Image(); image.id = "original-image"; image.alt = tr("originalAlt"); image.src = originalUrl;
  $("#original-slot").replaceChildren(image); $("#original").hidden = false;
  $("#name").textContent = tr("addNew"); $("#character-name").value = input.name; $("#draft-fields").hidden = false; $("#art-caption").hidden = false;
  renderAnalysis(analysis);
  $("#selection-status").textContent = tr("noOverwrite", { name: displayName(catalog.items.find(entry => entry.id === catalog.selected)) });
  api.setDirty(true);
  renderCatalog();
  status(tr(draft.blocked ? "analysisBlocked" : "analysisReady"), draft.blocked);
}, "characterImageOperationFailed"));
$("#apply").addEventListener("click", () => operation(async () => {
  const mode = draft?.mode, targetId = draft?.id || selected.id;
  catalog = await request(mode === "import"
    ? api.import({ svg: draft.svg, ...editedEntry() })
    : mode === "edit"
      ? api.update({ id: targetId, ...editedEntry() })
      : api.select(selected.id));
  api.setDirty(false);
  await showEntry(catalog.items.find(item => item.id === (mode === "edit" ? targetId : catalog.selected)));
  characters.forEach(character => character.react("hop"));
  reactionTimer = setTimeout(() => characters.forEach(character => character.react(null)), 800);
  status(mode === "edit" ? "" : tr(mode === "import" ? "characterAdded" : "characterChanged"));
}));
$("#cancel").addEventListener("click", () => operation(async () => {
  const targetId = draft?.mode === "edit" ? draft.id : catalog.selected;
  api.setDirty(false);
  await showEntry(catalog.items.find(item => item.id === targetId));
  status(tr("discarded"));
}));
$("#edit").addEventListener("click", () => operation(async () => {
  if (!selected || selected.builtin || !previewEntry?.analysis) return;
  draft = { mode: "edit", locale: currentLocale(), id: selected.id, svg: previewEntry.svg, name: selected.name, analysis: previewEntry.analysis, blocked: false };
  $("#name").textContent = tr("editName", { name: displayName(selected) });
  $("#selection-status").textContent = selected.id === catalog.selected ? tr("editCurrent") : tr("editingCurrent", { name: catalog.items.find(entry => entry.id === catalog.selected)?.name });
  $("#character-name").value = selected.name;
  $("#generation-instruction").value = "";
  $("#draft-fields").hidden = false;
  renderDraft();
  api.setDirty(true); renderCatalog();
  status("");
}));
$("#remove").addEventListener("click", () => operation(async () => {
  if (!confirm(tr("deleteConfirm", { name: displayName(selected), brand: appBrand() }))) return;
  catalog = await request(api.remove(selected.id));
  await showEntry(catalog.items.find(item => item.id === catalog.selected)); status(tr("deleted"));
}));
$("#motions").addEventListener("click", event => {
  const button = event.target.closest("button"); if (!button || busy) return;
  if (button.id === "pause") { paused = !paused; characters.forEach(character => character.setActive(!paused)); button.textContent = tr(paused ? "resumePreview" : "pausePreview"); button.setAttribute("aria-pressed", String(paused)); $("#motion-status").textContent = tr(paused ? "previewPaused" : "previewResumed"); return; }
  clearTimeout(reactionTimer); paused = false; $("#pause").textContent = tr("pausePreview"); $("#pause").setAttribute("aria-pressed", "false");
  characters.forEach(character => { character.setActive(true); character.reset(); if (button.dataset.gait) character.motion({ gait: button.dataset.gait }); if (button.dataset.reaction) character.react(button.dataset.reaction); });
  if (button.dataset.gait) previewGait = button.dataset.gait;
  document.querySelectorAll("[data-gait]").forEach(item => item.setAttribute("aria-pressed", String(item.dataset.gait === (button.dataset.gait || "idle"))));
  if (button.dataset.reaction) reactionTimer = setTimeout(() => characters.forEach(character => character.react(null)), Number(button.dataset.duration) || 800);
  $("#motion-status").textContent = tr("previewStatus", { motion: button.textContent });
});
$("#add-part").addEventListener("click", () => $("#parts-list").append(partRow()));
$("#draft-fields").addEventListener("click", event => {
  const button = event.target.closest("[data-generate-scope], [data-translate-scope]");
  if (button && !button.disabled) generateSuggestion(button.dataset.generateScope || button.dataset.translateScope, button.dataset.translateScope ? "translate" : "generate");
});
$("#discard-suggestion").addEventListener("click", () => {
  if (!draft?.proposal || busy) return;
  draft.proposal = undefined; renderProposal(); controls(); localGenerationStatus(tr("suggestionDiscarded"));
});
$("#adopt-suggestion").addEventListener("click", () => operation(async () => {
  if (!draft?.proposal) return;
  const proposal = draft.proposal;
  Object.assign(draft, adoptGeneratedFields(proposal));
  renderDraft();
  draft.proposal = undefined; renderProposal();
  // A different section may still be incomplete. Preview the validated proposal;
  // keep every unfinished edit in the form until the user explicitly saves it.
  await mount({ id: draft.id, svg: draft.svg, profile: profileFromAnalysis(proposal.analysis), analysis: proposal.analysis, builtin: false });
  localGenerationStatus(tr("suggestionAdopted", { section: generatedScopeName(proposal.scope) }));
}));
$(".stage").addEventListener("pointermove", event => {
  const rect = $("#large").getBoundingClientRect();
  characters.forEach(character => character.motion({ gait: previewGait, gaze: { x: event.clientX - (rect.x + rect.width / 2), y: event.clientY - (rect.y + rect.height * .46) } }));
});
$(".stage").addEventListener("pointerleave", () => characters.forEach(character => character.motion({ gait: previewGait, gaze: null })));
$("#catalog").addEventListener("keydown", event => {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const entries = Array.from(document.querySelectorAll(".entry")); if (!entries.length) return;
  const index = entries.indexOf(document.activeElement), next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
  event.preventDefault(); entries[next].focus(); entries[next].click();
});
$("#close").addEventListener("click", () => api.close());
$("#generation-settings").addEventListener("click", () => api.openSettings());
$("#status-action").addEventListener("click", () => api.openSettings());
window.addEventListener("keydown", event => { if (event.key === "Escape") api.close(); });
window.addEventListener("pagehide", () => { worker?.terminate(); clearTimeout(reactionTimer); characters.forEach(character => character.destroy()); clearOriginal(); }, { once: true });
function relabelSelect(selector, mapping) { document.querySelectorAll(`${selector} option`).forEach(option => { option.textContent = tr(mapping[option.value] || option.value); }); }
function renderSelectionLabels() {
  if (!catalog) {
    $("#name").textContent = tr("loadingCharacter");
    $("#selection-status").textContent = tr("readingCharacter");
    return;
  }
  const current = catalog.items.find(item => item.id === catalog.selected);
  if (draft?.mode === "import") {
    $("#name").textContent = tr("addNew");
    $("#selection-status").textContent = tr("noOverwrite", { name: displayName(current) });
  } else if (draft?.mode === "edit") {
    $("#name").textContent = tr("editName", { name: displayName(selected) });
    $("#selection-status").textContent = selected.id === catalog.selected ? tr("editCurrent") : tr("editingCurrent", { name: displayName(current) });
  } else if (selected) {
    $("#name").textContent = displayName(selected);
    $("#selection-status").textContent = selected.id === catalog.selected ? tr("currentCharacter") : tr("previewing", { name: displayName(current) });
  }
}
function renderLocale() {
  renderGenerationTiming();
  localizeDocument(); document.title = tr("libraryTitle", { brand: appBrand() });
  relabelSelect("#persona-archetype", { shy:"shy", proud:"proud", cheerful:"cheerful", calm:"calm", curious:"curious", mischievous:"mischievous" });
  relabelSelect("#persona-voice", { soft:"soft", reserved:"reserved", bright:"bright", steady:"steady", curious:"curious", playful:"playful" });
  relabelSelect("#egg-trigger", INTERACTION_KEYS);
  renderSelectionLabels();
  if (catalog) { controls(); renderCatalog(); }
  if (draft?.analysis) { Object.assign(draft, editedEntry()); draft.locale = currentLocale(); renderDraft(); renderProposal(); controls(); }
  else if (previewEntry) mount(previewEntry).catch(error => status(error.message, true));
}
await installLocalization(renderLocale);
api.onGenerationProgress((phase, diagnostics) => {
  if (busy && draft?.mode === "edit") {
    localGenerationStatus(tr(({ generation: "generatingSuggestion", translation: "translatingCurrent", repair: "repairingSuggestion" })[phase] || "generatingSuggestion"));
    renderGenerationTiming(diagnostics, phase === "repair");
  }
});
await operation(async () => { api.setDirty(false); catalog = await request(api.list()); await showEntry(catalog.items.find(item => item.id === catalog.selected)); document.body.dataset.ready = "true"; });
