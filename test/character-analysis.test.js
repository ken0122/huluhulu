import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { analyzeCharacterImage, generateCharacterFields, mergeGeneratedCharacterFields, validateCharacterAnalysis } from "../src/character-analysis.js";
import { characterText as characterTextForTest } from "../src/character-draft.js";

const valid = {
  quality: { decision: "pass", issues: [], explanation: "单个完整角色，背景简洁。" },
  persona: { archetype: "proud", voice: "reserved", identity: "一只黑猫", summary: "警觉而克制。", traits: ["警觉", "克制"] },
  dialogue: {
    headpat: ["只是刚好没躲"], tickle: ["爪子要伸出来了"], poke: ["……你戳我？"],
    cuddle: ["只准抱一会儿"], nuzzle: ["我只是路过"], hop: ["看见了"], shy: ["别一直盯着我"],
  },
  easterEgg: { label: "被发现的在意", description: "连续贴贴三次会露出真心。", triggerIntent: "nuzzle", message: "……被你发现了" },
  parts: [
    { kind: "body", confidence: .98, box: [.15, .08, .7, .86] },
    { kind: "eye", confidence: .92, box: [.28, .32, .12, .1] },
  ],
};

const locales = ["zh-CN", "zh-TW", "en", "ja", "fr", "de", "ru"];
const mockProvider = async () => ({ url: "https://models.example/v1/messages", key: "test-only", model: "chat-model" });
const four = line => [line, "第二句", "第三句", "第四句"];
const rawModelReply = value => Response.json({ content: [{ type: "text", text: JSON.stringify(value) }] });
const generatedPatch = value => ({...value,...(value.dialogue ? {dialogue:Object.fromEntries(Object.entries(value.dialogue).map(([intent,lines])=>[intent,Array.isArray(lines)&&lines.length===1 ? four(lines[0]) : lines]))} : {})});
const modelReply = value => rawModelReply(generatedPatch(value));
const completeAnalysis = value => ({ ...value, dialogueTranslations: { ...Object.fromEntries(locales.map(locale => [locale, value.dialogue])), ...value.dialogueTranslations } });

test("translation validation explains invalid text and keeps the 50 UTF-16 unit boundary", () => {
  const analysis = structuredClone(valid);
  analysis.dialogueTranslations = { en: structuredClone(valid.dialogue) };
  for (const [line, error] of [["a".repeat(51), /en headpat 翻译 1超过 50.*当前 51/],
    ["hello\nthere", /不能包含换行/], ["", /非空文本/], [42, /非空文本/], ["😀".repeat(26), /当前 52/]]) {
    analysis.dialogueTranslations.en.headpat = [line];
    assert.throws(() => validateCharacterAnalysis(analysis), error);
  }
  analysis.dialogueTranslations.en.headpat = ["😀".repeat(25)];
  assert.equal(validateCharacterAnalysis(analysis).dialogueTranslations.en.headpat[0].length, 50);
});

test("image text repair preserves the original geometry despite replacement boxes", async () => {
  const bytes = await readFile(new URL("../assets/characters/black-cat/source.png", import.meta.url));
  const invalid = { ...structuredClone(valid), dialogue: { ...valid.dialogue, headpat: ["a".repeat(51)] } };
  for (const badGeometry of [false, true]) {
    let count = 0, signal;
    const repaired = structuredClone(invalid);
    repaired.dialogue.headpat = ["One more pat is fine."];
    if (badGeometry) repaired.parts[0].box = [.9, .9, .8, .8];
    const promise = analyzeCharacterImage({ bytes, mime: "image/png" }, {
      provider: mockProvider,
      request: async (_url, options) => {
        const content = JSON.parse(options.body).messages[0].content;
        count++;
        if (count === 1) signal = options.signal;
        else {
          assert.notEqual(options.signal, signal);
          assert.ok(content.every(block => block.type === "text"));
        }
        return modelReply(completeAnalysis(count === 1 ? invalid : repaired));
      },
    });
    const result = await promise;
    assert.equal(result.dialogue.headpat[0], "One more pat is fine.");
    assert.deepEqual(result.parts, invalid.parts);
    assert.equal(count, 2);
  }
});

test("image analysis gives both generation and response repair 90 seconds", async t => {
  const bytes = await readFile(new URL("../assets/characters/black-cat/source.png", import.meta.url));
  const deadlines = [];
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", milliseconds => {
    deadlines.push(milliseconds);
    return originalTimeout(milliseconds);
  });
  let calls = 0;
  const result = await analyzeCharacterImage({ bytes, mime: "image/png" }, {
    provider: mockProvider,
    request: async () => calls++ === 0 ? Response.json({ content: [] }) : modelReply(completeAnalysis(valid)),
  });
  assert.equal(result.persona.identity, valid.persona.identity);
  assert.deepEqual(deadlines, [90_000, 90_000]);
});

test("text fallback and shape repair are bounded and HTTP failures are not retried", async () => {
  const svg = await readFile(new URL("../assets/characters/black-cat/character.svg", import.meta.url), "utf8");
  const input = { svg, name: "黑猫", analysis: valid, scope: "persona" };
  let count = 0;
  const clipped = await generateCharacterFields(input, {
    provider: mockProvider, request: async () => { count++; return modelReply({ name: "x".repeat(41), persona: valid.persona }); },
  });
  assert.equal(clipped.name, "x".repeat(40));
  assert.equal(count, 2);
  for (const [reply, expectedCalls, error] of [
    [() => modelReply({ name: "黑猫", persona: { ...valid.persona, archetype: "unknown" } }), 2, /角色气质/],
    [() => new Response(null, { status: 429 }), 1, /请求较多/],
  ]) {
    count = 0;
    await assert.rejects(generateCharacterFields(input, {
      provider: mockProvider, request: async () => { count++; return reply(); },
    }), error);
    assert.equal(count, expectedCalls);
  }
});

test("vision analysis uses the dedicated model and validates normalized part boxes", async () => {
  const bytes = await readFile(new URL("../assets/characters/black-cat/source.png", import.meta.url));
  const result = await analyzeCharacterImage({ bytes, mime: "image/png" }, {
    provider: async () => ({ url: "https://models.example/v1/messages", key: "test-only", model: "chat-model", visionModel: "vision-model" }),
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, "vision-model");
      assert.equal(body.messages[0].content[1].type, "image");
      assert.equal(body.messages[0].content[1].source.media_type, "image/png");
      assert.ok(body.messages[0].content[1].source.data.length > 100);
      return Response.json({ content: [{ type: "text", text: "```json\n" + JSON.stringify(generatedPatch(completeAnalysis(valid))) + "\n```" }] });
    },
  });
  assert.equal(result.persona.archetype, "proud");
  assert.equal(result.parts[1].kind, "eye");
  assert.equal(result.dialogue.nuzzle[0], "我只是路过");
  assert.equal(result.easterEgg.triggerIntent, "nuzzle");
});

test("vision suggestions cannot introduce unknown issues, parts or invalid geometry", () => {
  assert.throws(() => validateCharacterAnalysis({ ...valid, quality: { ...valid.quality, issues: ["run-code"] } }), /未知/);
  assert.throws(() => validateCharacterAnalysis({ ...valid, parts: [{ kind: "script", confidence: 1, box: [0,0,1,1] }] }), /部件/);
  assert.throws(() => validateCharacterAnalysis({ ...valid, parts: [{ kind: "body", confidence: 1, box: [.8,.8,.5,.5] }] }), /部件/);
});

test("text generation uses the chat model and treats the extra direction as bounded data", async () => {
  const svg = await readFile(new URL("../assets/characters/black-cat/character.svg", import.meta.url));
  const result = await generateCharacterFields({
    svg: svg.toString("utf8"), name: "我的黑猫", analysis: valid, scope: "persona", instruction: "更温柔，但保持克制",
  }, {
    provider: async () => ({ url: "https://models.example/v1/messages", key: "test-only", model: "chat-model", visionModel: "vision-model" }),
    request: async (_url, options) => {
      const body = JSON.parse(options.body), content = body.messages[0].content;
      assert.equal(body.model, "chat-model");
      assert.equal(content.length, 1);
      assert.equal(content[0].type, "text");
      assert.match(content[0].text, /更温柔，但保持克制/);
      return Response.json({ content: [{ type: "text", text: JSON.stringify({
        name: "温柔黑猫",
        persona: { ...valid.persona, voice: "soft", summary: "温柔而克制。", traits: ["温柔", "克制"] },
      }) }] });
    },
  });
  assert.equal(result.name, "温柔黑猫");
  assert.equal(result.analysis.persona.voice, "soft");
  assert.deepEqual(result.analysis.dialogue, validateCharacterAnalysis(valid).dialogue);
  await assert.rejects(generateCharacterFields({ svg: svg.toString("utf8"), name: "黑猫", analysis: valid, scope: "persona", instruction: "x".repeat(301) }), /300/);
});

test("single-interaction generation recovers missing, malformed and truncated JSON once", async () => {
  const svg = await readFile(new URL("../assets/characters/black-cat/character.svg", import.meta.url), "utf8");
  const patch = { dialogue: { headpat: ["再摸一下吧"] }, dialogueTranslations: Object.fromEntries(locales.map(locale => [locale, { headpat: ["One more pat, please."] }])) };
  const responses = [
    { content: [] },
    { content: [{ type: "text", text: '{"dialogue":null' }] },
    { content: [{ type: "text", text: '{"dialogue":' }] },
    { content: [{ type: "thinking", thinking: "private reasoning" }], stop_reason: "max_tokens" },
  ];
  for (const response of responses) {
    const calls = [];
    const result = await generateCharacterFields({ svg, name: "黑猫", analysis: valid, scope: "dialogue:headpat" }, {
      provider: mockProvider,
      request: async (_url, options) => {
        calls.push({ body: JSON.parse(options.body), signal: options.signal });
        return calls.length === 1 ? Response.json(response) : modelReply(patch);
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.max_tokens, 2048);
    assert.equal(calls[1].body.max_tokens, response.stop_reason === 'max_tokens' ? 8192 : 4096);
    assert.equal(new Set(calls.map(call => call.signal)).size, 2);
    assert.ok(calls.every(call => call.body.messages[0].content.every(block => block.type === "text")));
    const prompt = calls[0].body.messages[0].content[0].text;
    assert.ok(!prompt.includes(valid.dialogue.nuzzle[0]), "unrelated interaction text is not sent");
    assert.ok(!JSON.stringify(calls[1].body).includes("private reasoning"));
    assert.deepEqual(result.analysis.dialogue.headpat, generatedPatch(patch).dialogue.headpat);
    assert.deepEqual(result.analysis.dialogue.nuzzle, valid.dialogue.nuzzle);
    assert.deepEqual(Object.keys(result.analysis.dialogueTranslations), ["zh-CN"]);
  }
});

test("Messages string content and mixed blocks keep only the final text", async () => {
  const svg = await readFile(new URL("../assets/characters/black-cat/character.svg", import.meta.url), "utf8");
  const patch = { name: "黑猫", persona: valid.persona };
  for (const content of [JSON.stringify(patch), [null, { type: "thinking", thinking: "hidden" }, { type: "text", text: JSON.stringify(patch) }]]) {
    let calls = 0;
    const result = await generateCharacterFields({ svg, name: "黑猫", analysis: valid, scope: "persona" }, {
      provider: mockProvider,
      request: async () => { calls++; return Response.json({ content }); },
    });
    assert.equal(result.name, "黑猫");
    assert.equal(calls, 1);
  }
});

test("response retries remain bounded and incompatible or refused responses never retry", async () => {
  const svg = await readFile(new URL("../assets/characters/black-cat/character.svg", import.meta.url), "utf8");
  for (const [response, expectedCalls, error] of [
    [{ content: [] }, 2, /空正文/],
    [{ content: [{ type: "text", text: '{"dialogue":' }] }, 2, /未返回完整/],
    [{ content: [], stop_reason: "max_tokens" }, 2, /被截断/],
    [{ choices: [] }, 1, /返回结构不兼容/],
    [{ content: [], stop_reason: "refusal" }, 1, /拒绝/],
  ]) {
    let calls = 0;
    await assert.rejects(generateCharacterFields({ svg, name: "黑猫", analysis: valid, scope: "dialogue:headpat" }, {
      provider: mockProvider,
      request: async () => { calls++; return Response.json(response); },
    }), error);
    assert.equal(calls, expectedCalls);
  }
});

test('saved context lets each scope generate while unrelated draft fields are incomplete', async () => {
  const svg=await readFile(new URL('../assets/characters/black-cat/character.svg',import.meta.url),'utf8');
  const saved={name:'已保存名字',analysis:valid};
  const analysis={...structuredClone(valid),persona:{...valid.persona,identity:''},dialogue:{...valid.dialogue,headpat:[]},parts:[]};
  const original=structuredClone(analysis);
  const full={...valid,name:'新名字',dialogueTranslations:Object.fromEntries(locales.map(locale=>[locale,valid.dialogue]))};
  for(const scope of ['all','persona','dialogue','dialogue:headpat','easterEgg','parts']) {
    let calls=0;
    const result=await generateCharacterFields({svg,name:'',analysis,saved,scope},{locale:'en',provider:mockProvider,request:async(_url,options)=>{
      calls++;
      if (calls === 1 && scope !== "parts") assert.match(JSON.parse(options.body).messages[0].content[0].text,/English/);
      return modelReply(full);
    }});
    assert.equal(calls,1);
    assert.ok(result.analysis.persona.identity);
    assert.deepEqual(analysis,original);
  }
});

test('new generated dialogue must include every target instead of using legacy defaults',async()=>{
  const svg=await readFile(new URL('../assets/characters/black-cat/character.svg',import.meta.url),'utf8');
  for(const scope of ['all','dialogue','dialogue:headpat']) {
    let calls=0;
    await assert.rejects(generateCharacterFields({svg,name:'fixture',analysis:valid,scope},{provider:mockProvider,request:async()=>{
      calls++;return modelReply({...valid,name:'fixture',dialogue:{},dialogueTranslations:Object.fromEntries(locales.map(locale=>[locale,valid.dialogue]))});
    }}),error=>error.code==='CHAR_INVALID_OUTPUT' && /headpat/.test(error.message));
    assert.equal(calls,2);
  }
});

test('text-only repair cannot alter quality, enums, arrays or picture facts',async()=>{
  const bytes=await readFile(new URL('../assets/characters/black-cat/source.png',import.meta.url));
  const first={...structuredClone(valid),quality:{decision:'reject',issues:['cropped'],explanation:'裁切'},dialogue:{...valid.dialogue,headpat:['x'.repeat(51)]}};
  const repaired={...structuredClone(valid),persona:{...valid.persona,archetype:'calm',voice:'steady',identity:'Changed identity',traits:['Changed']},parts:[{kind:'body',confidence:1,box:[0,0,1,1]}]};
  let calls=0;
  const result=await analyzeCharacterImage({bytes,mime:'image/png'},{provider:mockProvider,request:async(_url,options)=>{
    calls++;if(calls===2)assert.ok(JSON.parse(options.body).messages[0].content.every(block=>block.type==='text'));
    return modelReply(completeAnalysis(calls===1?first:repaired));
  }});
  assert.equal(calls,2);
  assert.deepEqual(result.quality,first.quality);
  assert.deepEqual(result.parts,first.parts);
  assert.deepEqual(result.persona,first.persona);
  assert.deepEqual(result.dialogue.headpat,four(valid.dialogue.headpat[0]));
});

test('single-group generation preserves runtime fallback of every untouched foreign interaction', async()=>{
  const {localizedCustomProfile}=await import('../src/localized-profiles.js');
  const {profileFromAnalysis}=await import('../src/character-profile.js');
  const before=validateCharacterAnalysis(valid);
  const result=mergeGeneratedCharacterFields({name:'fixture',analysis:before,scope:'dialogue:headpat',patch:{dialogue:{headpat:['新摸头']},dialogueTranslations:Object.fromEntries(locales.map(locale=>[locale,{headpat:['new pat']}]))}});
  for(const locale of locales.filter(locale=>locale!=='zh-CN')) {
    const oldProfile=localizedCustomProfile(profileFromAnalysis(before),locale,before);
    const nextProfile=localizedCustomProfile(profileFromAnalysis(result.analysis),locale,result.analysis);
    for(const intent of Object.keys(valid.dialogue).filter(intent=>intent!=='headpat')) {
      assert.deepEqual(nextProfile.reactions[intent].messages,oldProfile.reactions[intent].messages);
      assert.equal(result.analysis.dialogueTranslations[locale]?.[intent],undefined);
    }
  }
});

test('text repair can fill a missing required string without replacing valid fields',async()=>{
  const svg=await readFile(new URL('../assets/characters/black-cat/character.svg',import.meta.url),'utf8');
  const first={name:'fixture',persona:{...valid.persona}};delete first.persona.identity;
  let calls=0;
  const result=await generateCharacterFields({svg,name:'fixture',analysis:valid,scope:'persona'},{provider:mockProvider,request:async()=>{
    calls++;return modelReply(calls===1?first:{name:'Changed',persona:{...valid.persona,summary:'Changed summary'}});
  }});
  assert.equal(calls,2);assert.equal(result.analysis.persona.identity,valid.persona.identity);
  assert.equal(result.analysis.persona.summary,valid.persona.summary);assert.equal(result.name,'fixture');
});

test('fresh image analysis requires complete current-language dialogue and an egg',async()=>{
  const bytes=await readFile(new URL('../assets/characters/black-cat/source.png',import.meta.url));
  for(const patch of [{...completeAnalysis(valid),dialogue:{}},{...completeAnalysis(valid),easterEgg:undefined}]) {
    let calls=0;
    await assert.rejects(analyzeCharacterImage({bytes,mime:'image/png'},{provider:mockProvider,request:async()=>{calls++;return modelReply(patch);}}),e=>e.code==='CHAR_INVALID_OUTPUT');
    assert.equal(calls,2);
  }
});

test('single dialogue uses valid draft persona and minimal context in one request', async () => {
  const saved = { name: '已保存黑猫', analysis: valid };
  const draft = { ...valid, persona: { ...valid.persona, summary: '尚未保存的新气质' } };
  const before = structuredClone(draft), calls = [];
  const result = await generateCharacterFields({ name: saved.name, analysis: draft, saved, scope: 'dialogue:headpat' }, {
    provider: async () => ({ ...(await mockProvider()), visionModel: 'must-not-use-vision' }),
    request: async (_url, options) => {
      const body = JSON.parse(options.body); calls.push(body);
      assert.equal(body.model, 'chat-model');
      assert.equal(body.messages[0].content.length, 1);
      const prompt = body.messages[0].content[0].text;
      assert.ok(prompt.includes(draft.persona.summary));
      if (calls.length === 1) {
        assert.ok(prompt.length < 800, `single source prompt has ${prompt.length} characters`);
        assert.ok(!prompt.includes('dialogueTranslations'));
        assert.ok(!prompt.includes('confidence'));
        assert.ok(!prompt.includes(valid.dialogue.nuzzle[0]));
        return modelReply({ dialogue: { headpat: ['保存气质的新原文'] } });
      }
      assert.match(prompt, /保存气质的新原文/);
      return modelReply({ dialogue: { headpat: ['翻译器不可改原文'] }, parts: [], dialogueTranslations: Object.fromEntries(locales.map(locale => [locale, { headpat: ['new translation'] }])) });
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(result.analysis.dialogue.headpat, four('保存气质的新原文'));
  assert.deepEqual(result.analysis.dialogueTranslations['zh-CN'].headpat, four('保存气质的新原文'));
  assert.deepEqual(result.analysis.parts, valid.parts);
  assert.deepEqual(draft, before);
});

test('source and repair timeouts fail without changing the draft', async () => {
  for (const stage of ['source', 'repair']) {
    let calls = 0;
    const before = structuredClone(valid);
    await assert.rejects(generateCharacterFields({ name: '黑猫', analysis: valid, scope: 'dialogue:headpat' }, {
      provider: mockProvider,
      request: async () => {
        calls++;
        if (calls === 1 && stage === 'translation') return modelReply({ dialogue: { headpat: ['已生成但未采用'] } });
        if (calls === 1 && stage === 'repair') return Response.json({ content: [] });
        throw new DOMException('fake slow body', 'TimeoutError');
      },
    }), error => error.code === ({source: 'CHAR_TIMEOUT', translation: 'CHAR_TRANSLATION_TIMEOUT', repair: 'CHAR_REPAIR_TIMEOUT'})[stage]);
    assert.equal(calls, stage === 'source' ? 1 : 2);
    assert.deepEqual(valid, before);
  }
});

test('a single generation can recover truncation with headroom and stay text-only', async () => {
  const calls = [];
  const result = await generateCharacterFields({ name: '黑猫', analysis: valid, scope: 'dialogue:headpat' }, {
    provider: async () => ({ ...(await mockProvider()), visionModel: 'must-not-use' }),
    request: async (_url, options) => {
      const body = JSON.parse(options.body); calls.push({ body, signal: options.signal });
      assert.ok(calls.length <= 4, 'one retry at most per stage');
      assert.equal(body.model, 'chat-model');
      assert.ok(body.messages[0].content.every(block => block.type === 'text'));
      assert.equal(body.thinking, undefined); assert.equal(body.effort, undefined);
      if (body.max_tokens < 4096) return Response.json({content:[{type:'text',text:'{"dialogue":'}],stop_reason:'max_tokens'});
      if (calls.length === 2) return modelReply({dialogue:{headpat:['新摸头原文']}});
      return modelReply({dialogueTranslations:Object.fromEntries(locales.filter(locale=>locale!=='zh-CN').map(locale=>[locale,{headpat:['A gentle pat.']}]))});
    },
  });
  assert.deepEqual(calls.map(call=>call.body.max_tokens),[2048,4096]);
  assert.equal(new Set(calls.map(call=>call.signal)).size,2);
  assert.deepEqual(result.analysis.dialogue.headpat,four('新摸头原文'));
  assert.deepEqual(result.analysis.dialogue.tickle,valid.dialogue.tickle);
});

test('new lines over 24 units are shortened by repair while saved 50-unit lines remain compatible', async () => {
  const current = { ...valid, dialogue: { ...valid.dialogue, headpat: ['旧'.repeat(40)] } };
  let calls = 0;
  const result = await generateCharacterFields({ name: '黑猫', analysis: current, scope: 'dialogue:headpat' }, {
    provider: mockProvider,
    request: async (_url, options) => {
      calls++;
      const prompt=JSON.parse(options.body).messages[0].content[0].text;
      assert.match(prompt,/24/);
      if(calls<=2)return modelReply({dialogue:{headpat:[calls===1?'长'.repeat(25):'再摸一下嘛']}});
      return modelReply({dialogueTranslations:Object.fromEntries(locales.map(locale=>[locale,{headpat:[calls===3?'x'.repeat(25):'One more pat!']}]))});
    },
  });
  assert.equal(calls,2);
  assert.deepEqual(result.analysis.dialogue.headpat,four('再摸一下嘛'));
  assert.equal(current.dialogue.headpat[0].length,40);
  assert.deepEqual(result.analysis.dialogue.tickle,valid.dialogue.tickle);
});

test('missing text groups and invalid persona or egg enums get one bounded repair', async () => {
  for (const [scope, first, fixed] of [
    ['persona', { name: '保留名称', persona: { ...valid.persona, archetype: 'friendly', traits: [] } }, { name: '不得覆盖', persona: { ...valid.persona, summary: '不得覆盖' } }],
    ['dialogue:headpat', { dialogue: { headpat: '格式错误' } }, { dialogue: { headpat: ['新摸头'] } }],
    ['easterEgg', { easterEgg: { ...valid.easterEgg, triggerIntent: 'pet' } }, { easterEgg: { ...valid.easterEgg, label: '不得覆盖' } }],
    ['easterEgg', {}, { easterEgg: valid.easterEgg }],
  ]) {
    const before = structuredClone(valid), calls = [];
    const result = await generateCharacterFields({ name: '原名', analysis: valid, scope }, {
      provider: mockProvider,
      request: async (_url, options) => {
        const body = JSON.parse(options.body); calls.push(body);
        assert.ok(body.messages[0].content.every(block => block.type === 'text'));
        return modelReply(calls.length === 1 ? first : calls.length === 2 ? fixed : {
          dialogueTranslations: Object.fromEntries(locales.map(locale => [locale, { headpat: ['A gentle pat.'] }])),
        });
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].max_tokens, calls[0].max_tokens * 2);
    if (scope === 'persona') {
      assert.equal(result.name, '保留名称');
      assert.equal(result.analysis.persona.summary, valid.persona.summary);
    }
    if (scope === 'easterEgg') assert.deepEqual(result.analysis.easterEgg, valid.easterEgg);
    assert.deepEqual(valid, before);
    assert.deepEqual(result.analysis.parts, valid.parts);
  }
});

test('shape repair of imported text preserves rejected quality and geometry', async () => {
  const bytes = await readFile(new URL('../assets/characters/black-cat/source.png', import.meta.url));
  const first = completeAnalysis({ ...valid, quality: {decision:'reject',issues:['cropped'],explanation:'裁切'}, dialogue: {...valid.dialogue,headpat:[]} });
  const repaired = completeAnalysis({...valid, parts:[{kind:'body',confidence:1,box:[0,0,1,1]}]});
  let calls = 0;
  const result = await analyzeCharacterImage({bytes,mime:'image/png'}, {provider:mockProvider,request:async(_url,options)=>{
    calls++;
    if (calls === 2) assert.ok(JSON.parse(options.body).messages[0].content.every(block=>block.type==='text'));
    return modelReply(calls === 1 ? first : repaired);
  }});
  assert.equal(calls,2);
  assert.deepEqual(result.quality,first.quality);
  assert.deepEqual(result.parts,first.parts);
  assert.deepEqual(result.dialogue.headpat,four(valid.dialogue.headpat[0]));
});

test('HTTP diagnostics preserve status but never response body or an extra attempt', async () => {
  let calls = 0;
  await assert.rejects(generateCharacterFields({name:'黑猫',analysis:valid,scope:'persona'}, {
    provider:mockProvider,request:async()=>{calls++;return new Response('secret upstream data',{status:404});},
  }), error => error.code === 'CHAR_HTTP' && error.details.status === 404 && !error.message.includes('secret'));
  assert.equal(calls,1);
});

test('complete validated source survive a gateway max_tokens stop marker', async () => {
  let calls = 0;
  const result = await generateCharacterFields({name:'黑猫',analysis:valid,scope:'dialogue:headpat'}, {
    provider:mockProvider,request:async()=>{
      calls++;
      const patch=calls===1?{dialogue:{headpat:['再摸一下嘛']}}:{dialogueTranslations:Object.fromEntries(locales.map(locale=>[locale,{headpat:['One more pat!']}]))};
      return Response.json({content:[{type:'text',text:JSON.stringify(generatedPatch(patch))}],stop_reason:'max_tokens',usage:{output_tokens:2048}});
    },
  });
  assert.equal(calls,1,'complete validated output needs no retry');
  assert.deepEqual(result.analysis.dialogue.headpat,four('再摸一下嘛'));
});

test('thinking-only token exhaustion is diagnosed without accepting or exposing reasoning', async () => {
  let calls = 0;
  await assert.rejects(generateCharacterFields({name:'黑猫',analysis:valid,scope:'dialogue:headpat'}, {
    provider:mockProvider,request:async()=>{
      calls++;
      return Response.json({content:[{type:'thinking',thinking:'private reasoning that must never be shown'}],stop_reason:'max_tokens',usage:{output_tokens:4096}});
    },
  }),error=>error.code==='CHAR_THINKING_LIMIT'&&!JSON.stringify(error).includes('private reasoning')&&error.details.phase==='generation');
  assert.equal(calls,2);
});

test('single interaction asks for and validates four separated natural lines without translations', async () => {
  let calls = 0;
  const result = await generateCharacterFields({name:'黑猫',analysis:valid,scope:'dialogue:headpat'}, {
    provider:mockProvider,request:async(_url,options)=>{
      calls++;
      if(calls===1) {
        const prompt=JSON.parse(options.body).messages[0].content[0].text;
        assert.match(prompt,/恰好 4 句被摸头/);
        assert.match(prompt,/直接输出台词本身/);
        assert.ok(!prompt.includes('dialogueTranslations'));
        assert.ok(!prompt.includes(valid.dialogue.tickle[0]));
        return Response.json({content:[{type:'thinking',thinking:'not a line'},{type:'text',text:'再摸一下嘛｜第二句｜第三句｜第四句'}],stop_reason:'end_turn'});
      }
      return modelReply({dialogueTranslations:Object.fromEntries(locales.map(locale=>[locale,{headpat:['One more pat!']}]))});
    },
  });
  assert.equal(calls,1);
  assert.deepEqual(result.analysis.dialogue.headpat,four('再摸一下嘛'));
});

test('all text scopes generate only the requested locale in one request, ignoring unsolicited translations and parts', async () => {
  for (const scope of ['all','persona','dialogue','easterEgg','dialogue:headpat']) {
    let calls=0; const before=completeAnalysis(valid);
    const result=await generateCharacterFields({name:'黑猫',analysis:before,scope}, {locale:'en',provider:mockProvider,request:async(_url,options)=>{
      calls++;const body=JSON.parse(options.body);
      assert.equal(body.messages[0].content.length,1);
      assert.match(body.messages[0].content[0].text,/English/);
      assert.equal(body.thinking,undefined);assert.equal(body.effort,undefined);
      return modelReply({...valid,name:'Cat',dialogue:{...valid.dialogue,headpat:['One more pat']},dialogueTranslations:{ru:{headpat:['unrequested']}},parts:[]});
    }});
    assert.equal(calls,1);assert.equal(result.locale,'en');
    assert.deepEqual(result.analysis.parts,valid.parts);
    assert.deepEqual(result.analysis.dialogue,valid.dialogue);
    assert.deepEqual(result.analysis.dialogueTranslations.ru,valid.dialogue);
  }
});

test('explicit translation handles just the target language, keeps source and mechanics, and repairs only invalid text',async()=>{
  const {characterText}=await import('../src/character-draft.js');
  let calls=0;const phases=[];
  const result=await generateCharacterFields({name:'黑猫',analysis:valid,scope:'all',action:'translate'}, {locale:'en',provider:mockProvider,onProgress:phase=>phases.push(phase),request:async(_url,options)=>{
    calls++;const prompt=JSON.parse(options.body).messages[0].content[0].text;
    if (calls === 1) { assert.match(prompt,/翻译成English/);assert.match(prompt,/不创作新情节/); }
    else assert.match(prompt,/逐项检查并修正当前区块/);
    return rawModelReply({...valid,name:'Black cat',persona:{...valid.persona,identity:'A black cat',archetype:'cheerful',voice:'bright'},dialogue:{...valid.dialogue,headpat:[calls===1?'x'.repeat(51):'One more pat']},easterEgg:{...valid.easterEgg,message:'You noticed',triggerIntent:'headpat'}});
  }});
  const visible=characterText(result,'en');
  assert.equal(calls,2);assert.deepEqual(phases,['translation','repair']);
  assert.equal(visible.name,'Black cat');assert.equal(visible.analysis.persona.archetype,'proud');
  assert.equal(visible.analysis.easterEgg.triggerIntent,'nuzzle');
  assert.deepEqual(visible.analysis.dialogue.headpat,['One more pat']);
  assert.deepEqual(result.analysis.dialogue,valid.dialogue);assert.equal(result.analysis.dialogueTranslations.ja,undefined);
});

test('retranslation uses the canonical source instead of translating an existing target version into itself', async () => {
  const analysis = structuredClone(valid);
  analysis.dialogueTranslations = { en: { headpat: ['Existing target one', 'Existing target two', 'Existing target three', 'Existing target four'] } };
  analysis.textLocaleOrder = ['en'];
  let prompt;
  const result = await generateCharacterFields({name:'黑猫', analysis, scope:'dialogue:headpat', action:'translate'}, {
    locale:'en', provider:mockProvider, request:async (_url, options) => {
      prompt = JSON.parse(options.body).messages[0].content[0].text;
      return rawModelReply({dialogue:{headpat:['Fresh source translation']}});
    },
  });
  assert.match(prompt, /只是刚好没躲/);
  assert.doesNotMatch(prompt, /Existing target/);
  assert.deepEqual(result.analysis.dialogueTranslations.en.headpat, ['Fresh source translation']);
});

test('generation and translation use one focused repair contract for overlong persona text', async () => {
  for (const action of ['generate', 'translate']) {
    const calls = [];
    const result = await generateCharacterFields({name:'黑猫', analysis:valid, scope:'persona', action}, {
      locale:'en', provider:mockProvider, request:async (_url, options) => {
        const body = JSON.parse(options.body); calls.push(body);
        if (calls.length === 1) return rawModelReply({
          name:'Black cat', persona:{...valid.persona, identity:'A black cat', summary:'x'.repeat(263)},
        });
        const prompt = body.messages[0].content[0].text;
        assert.match(prompt, /summary≤80/);
        assert.match(prompt, /逐项检查并修正当前区块/);
        assert.match(prompt, /自行逐项复核长度/);
        assert.match(prompt, /待修正JSON：\{"name":"Black cat"/);
        assert.ok(!prompt.includes('翻译成English'), 'repair does not repeat the source prompt');
        assert.ok(!prompt.includes('待修正JSON："{'), 'repair JSON is not double encoded');
        return rawModelReply({
          name:'Must not replace valid name', persona:{...valid.persona, identity:'Must not replace valid identity', summary:'Alert, reserved, and quietly affectionate.'},
        });
      },
    });
    const {characterText}=await import('../src/character-draft.js');
    const visible = characterText(result, 'en');
    assert.equal(calls.length, 2);
    assert.equal(visible.name, 'Black cat');
    assert.equal(visible.analysis.persona.identity, 'A black cat');
    assert.equal(visible.analysis.persona.summary, 'Alert, reserved, and quietly affectionate.');
  }
});

test('generation stays concise while translation gets bounded room to preserve meaning', async () => {
  const longLine = 'A reserved cat who quietly asks for one more gentle pat.'; // 55 UTF-16 units
  const translatedLine = longLine.slice(0, 37);
  const shortLines = ['One more pat', 'That feels nice', 'Please continue', 'Stay a moment'];

  let calls = 0;
  const translatedDialogue = await generateCharacterFields({name:'黑猫', analysis:valid, scope:'dialogue:headpat', action:'translate'}, {
    locale:'en', provider:mockProvider, request:async (_url, options) => {
      calls++;
      const prompt = JSON.parse(options.body).messages[0].content[0].text;
      assert.match(prompt, /每句≤50/); assert.doesNotMatch(prompt, /每句≤24/);
      return rawModelReply({dialogue:{headpat:[translatedLine]}});
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(translatedDialogue.analysis.dialogueTranslations.en.headpat, [translatedLine]);

  calls = 0;
  const generatedDialogue = await generateCharacterFields({name:'黑猫', analysis:valid, scope:'dialogue:headpat'}, {
    locale:'en', provider:mockProvider, request:async (_url, options) => {
      calls++;
      const prompt = JSON.parse(options.body).messages[0].content[0].text;
      assert.match(prompt, /每句≤24/);
      return rawModelReply({dialogue:{headpat:calls === 1 ? Array(4).fill(translatedLine) : shortLines}});
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(characterTextForTest(generatedDialogue, 'en').analysis.dialogue.headpat, shortLines);

  const translatedDescription = 'A hidden response appears after three gentle cuddles, revealing quiet affection.'.padEnd(81, '.');
  assert.equal(translatedDescription.length, 81);
  calls = 0;
  const translatedEgg = await generateCharacterFields({name:'黑猫', analysis:valid, scope:'easterEgg', action:'translate'}, {
    locale:'en', provider:mockProvider, request:async (_url, options) => {
      calls++;
      const prompt = JSON.parse(options.body).messages[0].content[0].text;
      assert.match(prompt, /description≤120/); assert.doesNotMatch(prompt, /description≤80/);
      return rawModelReply({easterEgg:{...valid.easterEgg, description:translatedDescription}});
    },
  });
  assert.equal(calls, 1);
  assert.equal(characterTextForTest(translatedEgg, 'en').analysis.easterEgg.description, translatedDescription);
  const localizedBoundary = structuredClone(translatedEgg.analysis);
  localizedBoundary.textVersions.en.easterEgg.description = 'x'.repeat(120);
  assert.equal(validateCharacterAnalysis(localizedBoundary).textVersions.en.easterEgg.description.length, 120);
  localizedBoundary.textVersions.en.easterEgg.description += 'x';
  assert.throws(() => validateCharacterAnalysis(localizedBoundary), /超过 120/);

  calls = 0;
  const generatedEgg = await generateCharacterFields({name:'黑猫', analysis:valid, scope:'easterEgg'}, {
    locale:'en', provider:mockProvider, request:async (_url, options) => {
      calls++;
      const prompt = JSON.parse(options.body).messages[0].content[0].text;
      assert.match(prompt, /description≤80/);
      return rawModelReply({easterEgg:{...valid.easterEgg, description:calls === 1 ? 'x'.repeat(81) : 'A hidden response after three gentle cuddles.'}});
    },
  });
  assert.equal(calls, 2);
  assert.equal(characterTextForTest(generatedEgg, 'en').analysis.easterEgg.description, 'A hidden response after three gentle cuddles.');
});

test('a still-overlong repair is locally capped by each generation or translation field rule', async () => {
  const cases = [
    {
      scope: 'dialogue:headpat', action: 'translate', maximum: 50,
      first: {dialogue:{headpat:['x'.repeat(54)]}},
      repaired: {dialogue:{headpat:['😀'.repeat(27)]}},
      read: result => characterTextForTest(result, 'en').analysis.dialogue.headpat[0],
      expected: '😀'.repeat(25),
    },
    {
      scope: 'easterEgg', action: 'translate', maximum: 120,
      first: {easterEgg:{...valid.easterEgg, description:'x'.repeat(168)}},
      repaired: {easterEgg:{...valid.easterEgg, description:'y'.repeat(168)}},
      read: result => characterTextForTest(result, 'en').analysis.easterEgg.description,
      expected: 'y'.repeat(120),
    },
    {
      scope: 'dialogue:headpat', action: 'generate', maximum: 24,
      first: {dialogue:{headpat:Array(4).fill('x'.repeat(37))}},
      repaired: {dialogue:{headpat:Array(4).fill('y'.repeat(37))}},
      read: result => characterTextForTest(result, 'en').analysis.dialogue.headpat[0],
      expected: 'y'.repeat(24),
    },
    {
      scope: 'easterEgg', action: 'generate', maximum: 80,
      first: {easterEgg:{...valid.easterEgg, description:'x'.repeat(81)}},
      repaired: {easterEgg:{...valid.easterEgg, description:'y'.repeat(81)}},
      read: result => characterTextForTest(result, 'en').analysis.easterEgg.description,
      expected: 'y'.repeat(80),
    },
  ];
  for (const item of cases) {
    let calls = 0;
    const result = await generateCharacterFields({name:'黑猫', analysis:valid, scope:item.scope, action:item.action}, {
      locale:'en', provider:mockProvider, request:async () => rawModelReply(++calls === 1 ? item.first : item.repaired),
    });
    assert.equal(calls, 2);
    assert.equal(item.read(result), item.expected);
    assert.ok(item.read(result).length <= item.maximum);
  }
});

test('failed explicit translation changes no saved text and reports its own phase',async()=>{
  const before=structuredClone(valid);let calls=0;
  await assert.rejects(generateCharacterFields({name:'黑猫',analysis:valid,scope:'dialogue:headpat',action:'translate'}, {locale:'en',provider:mockProvider,request:async()=>{
    calls++;return Response.json({content:[{type:'thinking',thinking:'never leak'}],stop_reason:'max_tokens'});
  }}),error=>error.code==='CHAR_THINKING_LIMIT'&&error.details.phase==='translation');
  assert.equal(calls,2);assert.deepEqual(valid,before);
});

test('DeepSeek official translation disables default thinking on the initial request and repair',async()=>{
  for(const repair of [false,true]) {
    const calls=[];
    const result=await generateCharacterFields({name:'黑猫',analysis:valid,scope:'persona',action:'translate'}, {
      locale:'en',provider:async()=>({url:'https://api.deepseek.com/anthropic/v1/messages',key:'fictional',model:'deepseek-v4-flash'}),
      request:async(url,options)=>{
        const body=JSON.parse(options.body);calls.push(body);
        assert.equal(url,'https://api.deepseek.com/anthropic/v1/messages');
        assert.equal(body.model,'deepseek-v4-flash');assert.equal(body.effort,undefined);assert.equal(body.output_config,undefined);
        assert.deepEqual(body.thinking,{type:'disabled'});
        if(repair&&calls.length===1)return rawModelReply({name:'Cat',persona:{...valid.persona,summary:''}});
        return rawModelReply({name:'Cat',persona:{...valid.persona,summary:'A curious cat.'}});
      },
    });
    assert.equal(calls.length,repair?2:1);
    assert.equal(calls[0].max_tokens,2048);
    assert.equal(result.analysis.textVersions.en.persona.summary,'A curious cat.');
    assert.deepEqual(result.analysis.persona,valid.persona);
  }
});

test('translation capability is not inferred from model names or lookalike gateways',async()=>{
  for(const [url,action] of [
    ['https://api.deepseek.com.evil.example/anthropic/v1/messages','translate'],
    ['https://api.deepseek.com/other/v1/messages','translate'],
    ['https://models.example/anthropic/v1/messages','translate'],
    ['https://api.deepseek.com/anthropic/v1/messages','generate'],
  ]) {
    await generateCharacterFields({name:'黑猫',analysis:valid,scope:'persona',action}, {
      locale:'en',provider:async()=>({url,key:'fictional',model:'deepseek-v4-flash'}),request:async(_url,options)=>{
        assert.equal(JSON.parse(options.body).thinking,undefined);
        return rawModelReply({name:'Cat',persona:valid.persona});
      },
    });
  }
});

test('only thinking exhaustion gets a longer independent deadline, including response body reads', async t => {
  const deadlines = [];
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', ms => { deadlines.push(ms); return originalTimeout(ms); });
  for (const scenario of ['thinking', 'empty', 'invalid']) {
    for (const timedOut of [false, true]) {
      deadlines.length = 0;
      const before = structuredClone(valid), signals = [], progress = [];
      const operation = generateCharacterFields({name:'黑猫',analysis:valid,scope:'persona',action:'translate'}, {
        locale:'en',provider:mockProvider,onProgress:(phase,value)=>progress.push({phase,value}),
        request:async (_url, options) => {
          signals.push(options.signal);
          const body=JSON.parse(options.body);
          assert.equal(body.thinking,undefined);assert.equal(body.effort,undefined);
          if(signals.length===1) return scenario==='thinking'
            ? Response.json({content:[{type:'thinking',thinking:'private'}],stop_reason:'max_tokens'})
            : scenario==='empty' ? Response.json({content:[]})
            : rawModelReply({name:'Cat',persona:{...valid.persona,summary:''}});
          assert.ok(signals.length<=2);
          if(timedOut) return {ok:true,json:async()=>{throw new DOMException('private body','TimeoutError');}};
          return rawModelReply({name:'Cat',persona:{...valid.persona,summary:'A curious cat.'}});
        },
      });
      if(timedOut) await assert.rejects(operation,error=>error.code==='CHAR_REPAIR_TIMEOUT' && error.details.timeoutSeconds===(scenario==='thinking'?90:30));
      else assert.equal((await operation).analysis.textVersions.en.persona.summary,'A curious cat.');
      assert.deepEqual(deadlines,[30000,scenario==='thinking'?90000:30000]);
      assert.notEqual(signals[0],signals[1]);
      assert.equal(progress[1].value.timeoutSeconds,scenario==='thinking'?90:undefined);
      assert.deepEqual(valid,before);
    }
  }
});

test('full-text generation gives the initial response and repair 90 seconds while smaller scopes keep 30', async t => {
  const deadlines = [];
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', ms => { deadlines.push(ms); return originalTimeout(ms); });
  let calls = 0;
  await generateCharacterFields({name:'黑猫',analysis:valid,scope:'all'}, {
    provider:mockProvider,request:async()=>{
      calls++;
      if(calls===1) return Response.json({content:[]});
      return modelReply({name:'黑猫',persona:valid.persona,dialogue:valid.dialogue,easterEgg:valid.easterEgg});
    },
  });
  assert.deepEqual(deadlines,[90000,90000]);

  deadlines.length=0;
  await generateCharacterFields({name:'黑猫',analysis:valid,scope:'persona'}, {
    provider:mockProvider,request:async()=>modelReply({name:'黑猫',persona:valid.persona}),
  });
  assert.deepEqual(deadlines,[30000]);
});

test('translation recovers thinking exhaustion with one bounded retry and preserves every line', async () => {
  for (const lines of [['摸摸头'], ['摸摸头', '再来一次']]) {
    const analysis = {...valid, dialogue: {...valid.dialogue, headpat: lines}};
    const calls = [], translated = ['Pat pat', 'One more time'].slice(0, lines.length);
    const result = await generateCharacterFields({name:'黑猫', analysis, scope:'dialogue:headpat', action:'translate'}, {
      locale:'en', provider:mockProvider, request:async (_url, options) => {
        const body = JSON.parse(options.body); calls.push({body, signal:options.signal});
        assert.equal(body.thinking, undefined); assert.equal(body.effort, undefined);
        if (body.max_tokens < 8192) return Response.json({content:[{type:'thinking', thinking:'private thought'}], stop_reason:'max_tokens'});
        return lines.length === 1 ? Response.json({content:[{type:'text', text:translated[0]}]}) : rawModelReply({dialogue:{headpat:translated}});
      },
    });
    assert.deepEqual(calls.map(call => call.body.max_tokens), [2048, 8192]);
    assert.notEqual(calls[0].signal, calls[1].signal);
    assert.ok(!JSON.stringify(calls).includes('private thought'));
    assert.deepEqual(result.analysis.dialogueTranslations.en.headpat, translated);
    assert.deepEqual(result.analysis.dialogue, analysis.dialogue);
  }
});

test('image import only requests current language and drops model-supplied translations',async()=>{
  const bytes=await readFile(new URL('../assets/characters/black-cat/source.png',import.meta.url));let calls=0;
  const result=await analyzeCharacterImage({bytes,mime:'image/png'}, {locale:'en',provider:mockProvider,request:async(_url,options)=>{
    calls++;const prompt=JSON.parse(options.body).messages[0].content[0].text;
    assert.match(prompt,/不生成任何翻译/);return modelReply(completeAnalysis(valid));
  }});
  assert.equal(calls,1);assert.equal(result.sourceLocale,'en');assert.deepEqual(Object.keys(result.dialogueTranslations),['en']);
});

test('explicit multi-line translation keeps all supplied lines and invalid actions make no requests',async()=>{
  const analysis={...valid,dialogue:{...valid.dialogue,headpat:['摸摸头','再来一次']}};
  let calls=0;
  const result=await generateCharacterFields({name:'黑猫',analysis,scope:'dialogue:headpat',action:'translate'}, {locale:'en',provider:mockProvider,request:async(_url,options)=>{
    calls++;const prompt=JSON.parse(options.body).messages[0].content[0].text;
    assert.match(prompt,/摸摸头/);assert.match(prompt,/再来一次/);assert.ok(!prompt.includes('直接输出翻译后的一句'));
    return rawModelReply({dialogue:{headpat:['Pat pat','One more time']}});
  }});
  assert.equal(calls,1);assert.deepEqual(result.analysis.dialogueTranslations.en.headpat,['Pat pat','One more time']);
  for(const input of [{scope:'parts',action:'translate'},{scope:'persona',action:'unknown'}])
    await assert.rejects(generateCharacterFields({name:'黑猫',analysis,...input},{provider:()=>assert.fail('invalid action accessed provider')}),error=>error.code==='CHAR_INVALID_INPUT');
});

test('translation cannot silently discard existing alternate lines',async()=>{
  let calls=0;
  const analysis={...valid,dialogue:{...valid.dialogue,headpat:['摸摸头','再来一次']}};
  const result=await generateCharacterFields({name:'黑猫',analysis,scope:'dialogue:headpat',action:'translate'}, {locale:'en',provider:mockProvider,request:async()=>{
    calls++;return rawModelReply({dialogue:{headpat:calls===1?['Pat pat']:['Pat pat','One more time']}});
  }});
  assert.equal(calls,2);assert.deepEqual(result.analysis.dialogueTranslations.en.headpat,['Pat pat','One more time']);
});

test('generation enforces exactly four lines in plain-text, section and all-text responses',async()=>{
  const lines=['摸摸头','再陪我会','好舒服呀','还想摸摸'];
  for(const scope of ['dialogue:headpat','dialogue','all']) {
    let calls=0;
    const result=await generateCharacterFields({name:'黑猫',analysis:valid,scope},{provider:mockProvider,request:async(_url,options)=>{
      calls++;const prompt=JSON.parse(options.body).messages[0].content[0].text;
      assert.match(prompt,/恰好 4 句/);
      if(scope==='dialogue:headpat')return Response.json({content:[{type:'text',text:lines.join('｜')}]});
      return rawModelReply({...valid,name:'黑猫',dialogue:Object.fromEntries(Object.keys(valid.dialogue).map(intent=>[intent,lines]))});
    }});
    assert.equal(calls,1);assert.deepEqual(result.analysis.dialogue.headpat,lines);
    if(scope!=='dialogue:headpat')for(const group of Object.values(result.analysis.dialogue))assert.equal(group.length,4);
  }
});

test('wrong generated counts get one repair, never padding or silently accepting 1–3 lines',async()=>{
  const lines=['第一句','第二句','第三句','第四句'];
  for(const length of [0,1,2,3,5]) {
    for(const repaired of [false,true]) {
      let calls=0;const before=structuredClone(valid);
      const work=generateCharacterFields({name:'黑猫',analysis:valid,scope:'dialogue:headpat'},{provider:mockProvider,request:async()=>{
        calls++;return rawModelReply({dialogue:{headpat:repaired&&calls===2?lines:Array.from({length},(_,i)=>`台词${i}`)}});
      }});
      if(repaired)assert.deepEqual((await work).analysis.dialogue.headpat,lines);
      else await assert.rejects(work,error=>error.code==='CHAR_INVALID_OUTPUT');
      assert.equal(calls,2);assert.deepEqual(valid,before);
    }
  }
});

test('manual dialogue still accepts 1–4 lines and explicit translation keeps a single line',async()=>{
  for(let count=1;count<=4;count++) {
    const manual={...valid,dialogue:{...valid.dialogue,headpat:Array.from({length:count},(_,i)=>`手写${i}`)}};
    assert.equal(validateCharacterAnalysis(manual).dialogue.headpat.length,count);
  }
  assert.throws(()=>validateCharacterAnalysis({...valid,dialogue:{...valid.dialogue,headpat:Array(5).fill('手写')}}));
  const result=await generateCharacterFields({name:'黑猫',analysis:valid,scope:'dialogue:headpat',action:'translate'},{locale:'en',provider:mockProvider,request:async()=>Response.json({content:[{type:'text',text:'Pat pat'}]})});
  assert.deepEqual(result.analysis.dialogueTranslations.en.headpat,['Pat pat']);
});

test('image analysis repairs missing generated lines without changing original geometry or quality',async()=>{
  const bytes=await readFile(new URL('../assets/characters/black-cat/source.png',import.meta.url));let calls=0;
  const result=await analyzeCharacterImage({bytes,mime:'image/png'},{provider:mockProvider,request:async()=>{
    calls++;return rawModelReply(calls===1?valid:{...generatedPatch(valid),quality:{...valid.quality,decision:'reject'},parts:[{kind:'body',confidence:1,box:[0,0,1,1]}]});
  }});
  assert.equal(calls,2);assert.deepEqual(result.quality,valid.quality);assert.deepEqual(result.parts,valid.parts);
  for(const lines of Object.values(result.dialogue))assert.equal(lines.length,4);
});

test('request diagnostics measure body consumption and expose one repair with its cause', async t => {
  let now = 0, calls = 0;
  t.mock.method(performance, 'now', () => now);
  const progress = [];
  const result = await generateCharacterFields({name:'黑猫',analysis:valid,scope:'dialogue:headpat'}, {
    provider: mockProvider,
    onProgress: (phase, diagnostics) => progress.push({phase, diagnostics}),
    request: async () => {
      calls++; now += 200;
      return {ok:true,json:async()=>{now += calls === 1 ? 1300 : 600;
        return {content:[{type:'text',text:calls === 1 ? '摸摸头' : '摸摸头｜再来一次｜舒服呀｜别停嘛'}]};
      }};
    },
  });
  assert.deepEqual(result.diagnostics, {attempts:[
    {phase:'generation',durationMs:1500},
    {phase:'repair',durationMs:800,reason:'CHAR_INVALID_OUTPUT'},
  ]});
  assert.deepEqual(progress, [
    {phase:'generation',diagnostics:{attempts:[]}},
    {phase:'repair',diagnostics:{attempts:[{phase:'generation',durationMs:1500}]}},
  ]);
  assert.deepEqual(result.analysis.dialogue.headpat, ['摸摸头','再来一次','舒服呀','别停嘛']);
});

test('diagnostics survive first-request failures and failed repairs without retrying HTTP or timeout', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  for (const scenario of ['success','auth','timeout','repair-timeout','invalid']) {
    let calls = 0;
    const job = generateCharacterFields({name:'黑猫',analysis:valid,scope:'dialogue:headpat'}, {
      provider:mockProvider,request:async()=>{
        calls++; now += calls === 1 ? 1700 : 30000;
        if (scenario === 'auth') return new Response(null,{status:401});
        if (scenario === 'timeout' || (scenario === 'repair-timeout' && calls === 2)) throw new DOMException('secret provider detail','TimeoutError');
        return Response.json({content:[{type:'text',text:scenario === 'success' ? '摸摸头｜再来一次｜舒服呀｜别停嘛' : '只有一句'}]});
      },
    });
    if (scenario === 'success') assert.deepEqual((await job).diagnostics,{attempts:[{phase:'generation',durationMs:1700}]});
    else await assert.rejects(job,error=>{
      assert.equal(error.diagnostics.attempts[0].durationMs,1700);
      assert.equal(error.diagnostics.attempts.length,['repair-timeout','invalid'].includes(scenario)?2:1);
      assert.ok(!JSON.stringify(error.diagnostics).includes('secret'));
      return true;
    });
    assert.equal(calls,['repair-timeout','invalid'].includes(scenario)?2:1);
  }
});

test('compact prompts include only requested scope rules and image recognition omits character text',async()=>{
  for (const scope of ['persona','dialogue','easterEgg','parts']) {
    let prompt;
    await generateCharacterFields({name:'黑猫',analysis:valid,scope,svg:'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle r="4" cx="5" cy="5"/></svg>'}, {
      provider:mockProvider,request:async(_url,options)=>{
        prompt=JSON.parse(options.body).messages[0].content[0].text;
        return modelReply({...valid,name:'黑猫'});
      },
    });
    if (scope !== 'parts') assert.ok(!prompt.includes('confidence'));
    if (scope !== 'easterEgg') assert.ok(!prompt.includes('triggerIntent'));
    if (scope === 'parts') assert.ok(!prompt.includes('警觉'));
    if (scope === 'dialogue') assert.ok(!prompt.includes('爪子要伸出来了'));
  }
});
