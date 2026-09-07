import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, globalShortcut, nativeImage, nativeTheme, Notification, screen, powerMonitor, systemPreferences } from "electron";
import { createDesktopTestSelection } from "./desktop-test-selection.mjs";

// Do not await app readiness at module top level: Electron awaits ESM evaluation.
// Real Electron windows, isolated app data. Live chat is explicitly opt-in.
await mkdir(path.resolve("work"), { recursive: true });
const testUserData = await mkdtemp(path.resolve("work/desktop-test-"));
app.setPath("userData", testUserData);
await writeFile(path.join(testUserData, "preferences-v1.json"), JSON.stringify({ version: 1, theme: "system", locale: "zh-CN" }));
process.env.BLUEPET_TEST_CHARACTER_ANALYSIS = "1";
const { characterApiFixture } = await import("./fixtures/character-api.mjs");
globalThis[Symbol.for("bluepet.characterTestServices")] = characterApiFixture;
const runtime = await import(process.env.BLUEPET_TEST_APP_ROOT
  ? pathToFileURL(path.join(process.env.BLUEPET_TEST_APP_ROOT, "src/main.js")).href
  : "../src/main.js");
const { getRuntime, ready, setMode, cycleMode, cycleCharacter, summonPet, toggleHidden, showChat, restorePetFrame, recoverWindows, shutdown } = runtime;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!await fn()) { if (Date.now() > deadline) throw new Error("Timed out waiting for runtime state"); await delay(30); }
}
const evaluate = code => getRuntime().petWindow.webContents.executeJavaScript(code);
async function toggleAndWait() {
  toggleHidden();
  if(getRuntime().state.manualHidden)await until(()=>!getRuntime().hiding,700);
}
async function focusWindow(win) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await until(() => {
      app.focus({ steal: true }); win.focus(); win.webContents.focus();
      return win.isFocused();
    }, 8000);
    await delay(120);
    if (win.isFocused()) return;
  }
  throw new Error("窗口焦点无法稳定保持");
}
const selection = createDesktopTestSelection();
const results = [];
const timings = [];
const suiteStartedAt = performance.now();
let currentCheck;
const resultFile = path.resolve("work/desktop-test-results.json");
async function writeResults(status, error) {
  await writeFile(resultFile, JSON.stringify({
    status, suite: selection.suite, tags: selection.requestedTags, filter: selection.filter,
    appRoot: process.env.BLUEPET_TEST_APP_ROOT || null,
    passed: results, failed: error ? currentCheck : undefined,
    timings, totalDurationMs: Math.round(performance.now() - suiteStartedAt),
    error: error?.message,
  }, null, 2));
}
async function check(name, tags, run) {
  if (!selection.matches(name, tags)) return;
  currentCheck = name;
  const startedAt = performance.now();
  try {
    await run();
  } finally {
    timings.push({ name, tags, durationMs: Math.round(performance.now() - startedAt) });
  }
  results.push(name); console.log("PASS", name, `${timings.at(-1).durationMs}ms`);
  currentCheck = undefined;
  await writeResults("running");
}
async function visiblePixels(win = getRuntime().petWindow) {
  const capture = await win.webContents.capturePage();
  const bitmap = capture.toBitmap();
  let blue = 0;
  for (let i=0; i<bitmap.length; i+=4) if(bitmap[i] > bitmap[i+2]*1.3 && bitmap[i+3]>100) blue++;
  assert.ok(blue > 600, "character should have >600 real blue pixels, got " + blue);
  return capture;
}
function yellowPixels(capture) {
  const bitmap = capture.toBitmap(); let count = 0;
  for (let i = 0; i < bitmap.length; i += 4) {
    if (bitmap[i] < 150 && bitmap[i + 1] > 150 && bitmap[i + 2] > 200 && bitmap[i + 3] > 100) count++;
  }
  return count;
}
async function run() {
try {
  await writeResults("running");
  await ready;
  await until(() => getRuntime().petWindow && !getRuntime().petWindow.webContents.isLoading());
  await delay(200);
  await until(()=>evaluate("Boolean(document.querySelector('.mascot-svg'))"));
  await check("Reminders: chat creation, replacement, native delivery, hidden/game fallback and recovery", ["smoke", "chat", "reminders", "focus"], async () => {
    const previousEnv = Object.fromEntries(["BLUEPET_API_BASE_URL", "BLUEPET_API_KEY", "BLUEPET_CHAT_MODEL"].map(key => [key, process.env[key]]));
    Object.assign(process.env, { BLUEPET_API_BASE_URL: "https://reminder-test.example", BLUEPET_API_KEY: "test-only-reminder", BLUEPET_CHAT_MODEL: "mock-model" });
    let next = { intent: "create", text: "喝水", seconds: 2 }, calls = 0, notifications = 0;
    const realShow = Notification.prototype.show;
    Notification.prototype.show = function () { notifications++; };
    runtime.setReminderRequestForTest(async () => { calls++; return Response.json({ content: [{ type: "text", text: JSON.stringify(next) }] }); });
    const competitor = new BrowserWindow({ width: 300, height: 140, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await competitor.loadURL("about:blank");
    const send = async message => {
      await evaluate(`document.querySelector('#message').value=${JSON.stringify(message)};document.querySelector('#chat-form').requestSubmit()`);
      await until(() => evaluate("!document.body.classList.contains('is-thinking')"));
    };
    const clearNote = () => {
      const manager = getRuntime().reminders, snap = manager.snapshot();
      if (snap.note) manager.action({ action: "cancel", id: snap.note.id, revision: snap.revision });
    };
    try {
      setMode("pet"); showChat(); await delay(100);
      await send("两秒后提醒我喝水");
      assert.equal(getRuntime().reminders.snapshot().note.text, "喝水");
      const { readFile } = await import("node:fs/promises");
      assert.equal((await readFile(path.join(testUserData, "reminder-v1.enc"))).includes(Buffer.from("喝水")), false);
      restorePetFrame(); competitor.show(); await focusWindow(competitor);
      let petStoleFocus = false;
      const trackFocus = () => { petStoleFocus = true; };
      getRuntime().petWindow.on("focus", trackFocus);
      await until(() => evaluate("document.querySelector('.speech').classList.contains('note-due')"), 4500);
      getRuntime().petWindow.removeListener("focus", trackFocus);
      assert.equal(petStoleFocus, false, "automatic reminder never requests native keyboard focus");
      assert.equal(getRuntime().petWindow.isFocused(), false);
      assert.deepEqual([getRuntime().petWindow.getBounds().width, getRuntime().petWindow.getBounds().height], [272, 242]);
      assert.equal(notifications, 0, "visible delivery does not also create a system notification");
      const rect = await evaluate(`(()=>{const p=document.querySelector('#note-panel').getBoundingClientRect(), a=document.querySelector('#note-actions').getBoundingClientRect();return {bottom:p.bottom,actions:a.bottom,scroll:document.documentElement.scrollWidth,width:innerWidth}})()`);
      assert.ok(rect.actions <= rect.bottom + 1); assert.equal(rect.scroll, rect.width);
      getRuntime().trayMenu.getMenuItemById("theme-light").click(); await delay(1700);
      await writeFile(path.resolve("work/reminder-implementation/due-light.png"), (await getRuntime().petWindow.webContents.capturePage()).toPNG());
      getRuntime().trayMenu.getMenuItemById("theme-dark").click(); await delay(120);
      await writeFile(path.resolve("work/reminder-implementation/due-dark.png"), (await getRuntime().petWindow.webContents.capturePage()).toPNG());
      for (const language of ["zh-TW", "en", "ja", "fr", "de", "ru", "zh-CN"]) {
        getRuntime().trayMenu.getMenuItemById("locale-" + language).click();
        await until(() => evaluate(`document.documentElement.lang===${JSON.stringify(language)}`));
        assert.ok(await evaluate("document.querySelector('#note-actions').getBoundingClientRect().bottom <= document.querySelector('.speech').getBoundingClientRect().bottom - 10"));
      }
      await evaluate("document.querySelector('#dismiss').click()"); await until(() => !getRuntime().state.chatOpen);
      runtime.checkReminders(); await delay(100);
      assert.equal(getRuntime().state.chatOpen, false); assert.equal(getRuntime().reminders.snapshot().note.dismissed, true);
      showChat(); await delay(100); await evaluate("document.querySelector('[data-action=ack]').click()");
      await until(() => !getRuntime().reminders.snapshot().note);

      showChat(); next = { intent: "create", text: "记得带充电器", seconds: 600 };
      await send("十分钟后提醒我带充电器");
      await evaluate("document.querySelector('#note-back').click()"); await until(() => evaluate("!document.querySelector('#chat-content').hidden"));
      next = { intent: "create", text: "喝水", seconds: 900 }; await send("十五分钟后提醒我喝水");
      await until(() => evaluate("!!document.querySelector('[data-action=replace]')"));
      await writeFile(path.resolve("work/reminder-implementation/replace-dark.png"), (await getRuntime().petWindow.webContents.capturePage()).toPNG());
      assert.equal(getRuntime().reminders.snapshot().note.text, "记得带充电器");
      await evaluate("document.querySelector('[data-action=keep]').click()");
      await until(() => !getRuntime().reminders.snapshot().proposal);
      await evaluate("document.querySelector('#note-back').click()"); await delay(50);
      await send("十五分钟后提醒我喝水");
      await evaluate("document.querySelector('[data-action=replace]').click()");
      await until(() => getRuntime().reminders.snapshot().note.text === "喝水");
      await evaluate("document.querySelector('[data-action=cancel]').click()");
      await until(() => !getRuntime().reminders.snapshot().note);

      // While typing, only the badge changes; content and input stay untouched.
      next = { intent: "create", text: "喝水", seconds: 1 }; await send("一秒后提醒我喝水");
      await evaluate("document.querySelector('#note-back').click()"); await delay(50);
      await evaluate("document.querySelector('#message').value='未发送的草稿'");
      await delay(1100); runtime.checkReminders();
      assert.equal(await evaluate("document.querySelector('#message').value"), "未发送的草稿");
      assert.equal(await evaluate("document.querySelector('#chat-content').hidden"), false);
      assert.equal(await evaluate("document.querySelector('#note-badge').textContent"), "叮，约好的时间到啦");
      clearNote(); restorePetFrame();

      for (const destination of ["hidden", "beans"]) {
        showChat(); next = { intent: "create", text: "喝水", seconds: 1 }; await send("一秒后提醒我喝水");
        restorePetFrame();
        if (destination === "hidden") await toggleAndWait(); else setMode("beans");
        await delay(1100); runtime.checkReminders(); runtime.checkReminders();
        assert.equal(notifications, destination === "hidden" ? 1 : 2);
        if (destination === "hidden") { assert.equal(getRuntime().petWindow.isVisible(), false); await toggleAndWait(); }
        else { assert.equal(getRuntime().state.mode, "beans"); setMode("pet"); }
        runtime.checkReminders(); await until(() => evaluate("document.querySelector('.speech').classList.contains('note-due')"));
        clearNote(); restorePetFrame();
      }
      const before = calls;
      assert.ok(before >= 7); // Only user submissions used the mock provider.
      powerMonitor.emit("unlock-screen"); runtime.checkReminders();
      assert.equal(calls, before);
    } finally {
      clearNote(); competitor.destroy();
      runtime.setReminderRequestForTest(undefined); Notification.prototype.show = realShow;
      for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      if (getRuntime().state.manualHidden) await toggleAndWait();
      setMode("pet"); restorePetFrame();
      getRuntime().trayMenu.getMenuItemById("theme-system").click();
      getRuntime().trayMenu.getMenuItemById("locale-zh-CN").click();
    }
  });
  await check("Reminders: reduced motion before display and live, lock/resume and Dodge hit testing", ["reminders", "motion", "focus"], async () => {
    const win = getRuntime().petWindow, manager = getRuntime().reminders;
    const clear = () => { const s = manager.snapshot(); if (s.note) manager.action({ action: "cancel", id: s.note.id, revision: s.revision }); };
    const create = () => manager.submit(async () => ({ intent: "create", text: "桌面验证纸条", dueAt: Date.now() + 250 }));
    const realCursor = screen.getCursorScreenPoint;
    win.webContents.debugger.attach("1.3");
    const reduce = value => win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value }] });
    try {
      setMode("dodge"); restorePetFrame();
      screen.getCursorScreenPoint = () => ({ x: 0, y: 0 });
      await reduce("reduce"); await create(); await delay(280); runtime.checkReminders();
      await until(() => evaluate("document.querySelector('.speech').classList.contains('note-due')"));
      assert.ok(await evaluate("parseFloat(getComputedStyle(document.querySelector('.speech')).animationDuration) < 0.001"));
      assert.equal(getRuntime().ignoringMouse, true);
      screen.getCursorScreenPoint = () => ({ x: win.getBounds().x + 80, y: win.getBounds().y + 55 });
      await until(() => !getRuntime().ignoringMouse);
      const stopped = win.getPosition(); await delay(120); assert.deepEqual(win.getPosition(), stopped);
      clear(); restorePetFrame(); await reduce("no-preference");
      await create(); await delay(280); runtime.checkReminders();
      await until(() => evaluate("document.querySelector('.speech').classList.contains('note-due')"));
      await reduce("reduce");
      assert.ok(await evaluate("parseFloat(getComputedStyle(document.querySelector('.note-sparkles path')).animationDuration) < 0.001"));
      clear(); restorePetFrame();
      powerMonitor.emit("lock-screen"); powerMonitor.emit("suspend");
      await create(); await delay(280); runtime.checkReminders();
      assert.equal(getRuntime().state.chatOpen, false);
      powerMonitor.emit("resume"); assert.equal(getRuntime().state.chatOpen, false, "resume must not bypass a still-locked screen");
      powerMonitor.emit("unlock-screen");
      await until(() => getRuntime().state.chatOpen);
      assert.equal(manager.snapshot().note.due, true);
    } finally {
      clear(); restorePetFrame(); screen.getCursorScreenPoint = realCursor;
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
      win.webContents.debugger.detach();
      powerMonitor.emit("unlock-screen");
    }
  });
  await check("appearance and language switch live without reloading or losing state", ["smoke", "appearance", "settings"], async () => {
    setMode("pet"); showChat(); await until(() => getRuntime().state.chatOpen && getRuntime().petWindow.isVisible());
    const win = getRuntime().petWindow, id = win.webContents.id;
    await evaluate("document.querySelector('#message').value='keep-this-draft'");
    getRuntime().trayMenu.getMenuItemById("locale-de").click();
    await until(() => evaluate("document.documentElement.lang === 'de'"));
    assert.equal(getRuntime().trayMenu.getMenuItemById("quit").label, "Hulu Hulu beenden");
    assert.equal(await evaluate("document.querySelector('#message').value"), "keep-this-draft");
    assert.equal(win.webContents.id, id, "locale changes do not reload the renderer");
    getRuntime().trayMenu.getMenuItemById("theme-dark").click();
    await until(() => evaluate("matchMedia('(prefers-color-scheme: dark)').matches"));
    assert.equal(nativeTheme.themeSource, "dark");
    getRuntime().trayMenu.getMenuItemById("api-settings").click();
    await until(() => getRuntime().settingsWindow?.isVisible());
    const settings = getRuntime().settingsWindow;
    assert.equal(await settings.webContents.executeJavaScript("document.documentElement.lang"), "de");
    assert.equal(await settings.webContents.executeJavaScript("document.documentElement.dataset.theme"), "dark");
    assert.equal(await settings.webContents.executeJavaScript("getComputedStyle(document.documentElement).backgroundColor"), "rgb(17, 24, 43)");
    assert.equal(await settings.webContents.executeJavaScript("document.querySelector('h1').textContent"), "Chat-Einstellungen");
    assert.match(await settings.webContents.executeJavaScript("document.querySelector('.intro').textContent"), /Anthropic[- ]Messages/);
    settings.close();
    getRuntime().trayMenu.getMenuItemById("characters").click();
    await until(() => getRuntime().characterWindow?.isVisible());
    const library = getRuntime().characterWindow;
    await until(() => library.webContents.executeJavaScript("document.body.dataset.ready === 'true'"));
    assert.equal(await library.webContents.executeJavaScript("document.documentElement.lang"), "de");
    assert.equal(await library.webContents.executeJavaScript("document.documentElement.dataset.theme"), "dark");
    assert.equal(await library.webContents.executeJavaScript("getComputedStyle(document.documentElement).backgroundColor"), "rgb(17, 24, 43)");
    assert.equal(await library.webContents.executeJavaScript("document.querySelector('h1').textContent"), "Charaktere");
    assert.equal(await library.webContents.executeJavaScript("document.querySelector('#choose').textContent"), "Charakter hinzufügen…");
    assert.match(await library.webContents.executeJavaScript("document.querySelector('#capabilities').textContent"), /Augenanimation/);
    getRuntime().trayMenu.getMenuItemById("theme-light").click();
    await until(() => library.webContents.executeJavaScript("document.documentElement.dataset.theme === 'light'"));
    assert.equal(await library.webContents.executeJavaScript("getComputedStyle(document.documentElement).backgroundColor"), "rgb(251, 252, 255)");
    assert.equal(await library.webContents.executeJavaScript("getComputedStyle(document.documentElement).colorScheme"), "light");
    getRuntime().trayMenu.getMenuItemById("theme-dark").click();
    await until(() => library.webContents.executeJavaScript("document.documentElement.dataset.theme === 'dark'"));
    const librarySize = library.getSize();
    library.setSize(720, 620);
    await until(() => library.webContents.executeJavaScript("innerWidth === 720"));
    for (const choice of ["de", "fr", "ru"]) {
      getRuntime().trayMenu.getMenuItemById("locale-" + choice).click();
      await until(() => library.webContents.executeJavaScript(`document.documentElement.lang === ${JSON.stringify(choice)}`));
      const layout = await library.webContents.executeJavaScript(`(() => {
        const rects = [...document.querySelectorAll('#motions button')].map(node => {
          const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        });
        const overlaps = rects.some((a, index) => rects.slice(index + 1).some(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top));
        const rows = [...new Set(rects.map(rect => Math.round(rect.top)))];
        const pause = document.querySelector('#pause').getBoundingClientRect();
        return { overlaps, rows: rows.length, pageOverflow: document.documentElement.scrollWidth > innerWidth, actionsBottom: document.querySelector('.manage-actions').getBoundingClientRect().bottom, viewportBottom: innerHeight, pauseWidth: pause.width, name: document.querySelector('#name').textContent };
      })()`);
      assert.deepEqual({ overlaps: layout.overlaps, rows: layout.rows, pageOverflow: layout.pageOverflow }, { overlaps: false, rows: 2, pageOverflow: false }, choice);
      assert.ok(layout.actionsBottom <= layout.viewportBottom, choice + " actions remain reachable");
      assert.ok(layout.pauseWidth >= 120, choice + " reserves room for the longest action");
      assert.equal(layout.name, "Hulu Hulu", choice + " preserves the dynamic character name");
    }
    await writeFile(path.resolve("work/character-library-i18n-layout.png"), (await library.webContents.capturePage()).toPNG());
    library.setSize(...librarySize);
    library.close(); restorePetFrame();
    await toggleAndWait();
    getRuntime().trayMenu.getMenuItemById("locale-fr").click();
    assert.equal(getRuntime().state.manualHidden, true);
    assert.equal(win.isVisible(), false, "preference changes cannot reveal a manual hide");
    getRuntime().trayMenu.getMenuItemById("locale-zh-CN").click();
    getRuntime().trayMenu.getMenuItemById("theme-system").click();
    await toggleAndWait();
    await until(() => getRuntime().petWindow.isVisible());
    await until(() => getRuntime().preferences.resolvedLocale === "zh-CN");
  });
  await check("Character library: preview/apply, hidden state, live replacement and game continuity", ["character", "focus"], async () => {
    setMode("pet"); await until(() => !getRuntime().modeTransition, 7000);
    await toggleAndWait();
    getRuntime().trayMenu.getMenuItemById("characters").click();
    await until(() => getRuntime().characterWindow?.isVisible());
    const win = getRuntime().characterWindow, js = code => win.webContents.executeJavaScript(code);
    await until(() => js("document.body.dataset.ready === 'true'"));
    assert.equal(getRuntime().state.manualHidden, true);
    assert.equal(getRuntime().petWindow.isVisible(), false);
    assert.equal(win.isAlwaysOnTop(), false, "角色窗口不应挡住其他应用");
    assert.equal(await js("typeof window.bluepet"), "undefined");
    const prefs = win.webContents.getLastWebPreferences();
    assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
    getRuntime().trayMenu.getMenuItemById("characters").click(); assert.equal(getRuntime().characterWindow, win);
    assert.equal(await js("document.querySelector('[data-id=sunny-yellow] small').textContent"), "内置");
    await js("document.querySelector('[data-id=sunny-yellow]').click()");
    await until(() => js("document.querySelector('#large svg')?.dataset.character === 'sunny-yellow' && !document.querySelector('#apply').disabled"));
    assert.deepEqual(await js("[document.querySelectorAll('.sunny-pupils').length,document.querySelectorAll('.sunny-pupils circle').length]"), [3,6]);
    assert.match(await js("document.querySelector('#personality').textContent"), /开朗.*爱庆祝/);
    assert.match(await js("document.querySelector('#easter-egg').textContent"), /三连点亮/);
    assert.match(await js("document.querySelector('#capabilities').textContent"), /珊瑚色眼睛会跟随/);
    await until(async () => yellowPixels(await win.webContents.capturePage()) > 500);
    await js("document.querySelector('button[data-gait=run]').click()");
    await until(() => js("getComputedStyle(document.querySelector('#large .character-gait-outline')).d !== 'none' && document.querySelector('#large .character-gait-outline').getAnimations()[0]?.effect.getTiming().duration === 220"));
    await js("document.querySelector('button[data-gait=idle]').click()");
    await js("document.querySelector('.stage').dispatchEvent(new PointerEvent('pointermove',{clientX:700,clientY:120,bubbles:true}))");
    assert.equal(await js("document.querySelector('#large svg').dataset.looking"), "true");
    await js("document.querySelector('#egg-preview').click()");
    assert.equal(await js("document.querySelector('#large svg').dataset.reaction"), "sunny-secret");
    await js("document.querySelector('#apply').click()");
    await until(() => evaluate("document.querySelector('.mascot-svg').dataset.character === 'sunny-yellow'"));
    assert.equal(await evaluate("document.querySelectorAll('.sunny-pupils circle').length"), 2);
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.affection span'),node=>node.textContent)"), ["✦","☀","✦"]);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.affection span')).color"), "rgb(244, 163, 64)");
    assert.equal(await evaluate("document.querySelectorAll('.mascot-svg [fill=\"#ffd45a\"]').length"), 1, "隐藏状态下也应完成小太阳的桌面 SVG 替换");
    await js("document.querySelector('[data-id=black-cat]').click()");
    await until(() => js("document.querySelector('#large svg')?.dataset.character === 'black-cat' && !document.querySelector('#apply').disabled"));
    assert.deepEqual(await js("[document.querySelectorAll('.cat-pupils').length,document.querySelectorAll('.cat-pupils circle').length]"), [3,6]);
    assert.match(await js("document.querySelector('#capabilities').textContent"), /眼睛会跟随/);
    assert.match(await js("document.querySelector('#selection-status').textContent"), /预览中.*当前角色/);
    assert.equal(await js("document.querySelector('[data-id=sunny-yellow] .current-badge').textContent"), "当前");
    await js("document.querySelector('.stage').dispatchEvent(new PointerEvent('pointermove',{clientX:700,clientY:120,bubbles:true}))");
    assert.equal(await js("document.querySelector('#large svg').dataset.looking"), "true");
    assert.notEqual(await js("document.querySelector('#large svg').style.getPropertyValue('--gaze-x')"), "0.00px");
    await js("document.querySelector('.stage').dispatchEvent(new PointerEvent('pointerleave',{bubbles:true}))");
    assert.equal(await js("document.querySelector('#large svg').dataset.looking"), undefined);
    assert.equal(await evaluate("document.querySelector('.mascot-svg').dataset.character"), "sunny-yellow", "preview alone must not apply");
    await evaluate("window.oldCharacter = document.querySelector('.mascot-svg')");
    await js("document.querySelector('#apply').click()");
    await until(() => evaluate("document.querySelector('.mascot-svg').dataset.character === 'black-cat' && document.querySelector('#pet').dataset.hideCharacter === 'black-cat'"));
    assert.equal(await evaluate("window.oldCharacter.dataset.active"), "false");
    assert.equal(await evaluate("document.querySelector('.mascot-svg').dataset.active"), "false");
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.affection span'),node=>node.textContent)"), ["✦","♥","✦"]);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.affection span')).color"), "rgb(242, 188, 82)");
    assert.equal(await evaluate("document.querySelectorAll('.cat-pupils circle').length"), 2);
    assert.equal(await js("document.querySelector('#apply').textContent"), "正在使用");
    assert.equal(await js("document.querySelector('#apply').classList.contains('is-current')"), true);
    assert.equal(await js("document.querySelector('[data-id=black-cat] .current-badge').textContent"), "当前");
    assert.equal(getRuntime().state.manualHidden, true);
    assert.equal(getRuntime().petWindow.isVisible(), false);
    await toggleAndWait();
    win.hide(); await until(() => !win.isVisible());
    const petWindow = getRuntime().petWindow;
    await focusWindow(petWindow);
    let beforeMove;
    for (let attempt=0; attempt<3; attempt++) {
      await focusWindow(petWindow); beforeMove=petWindow.getPosition();
      petWindow.webContents.sendInputEvent({type:"keyDown",keyCode:"LEFT"}); await delay(200);
      if (await evaluate("document.querySelector('.mascot-svg').dataset.gait==='run'")) break;
      petWindow.webContents.sendInputEvent({type:"keyUp",keyCode:"LEFT"});
    }
    assert.ok(petWindow.getPosition()[0] < beforeMove[0] - 10, "black cat must move the native window");
    assert.equal(await evaluate("document.querySelector('.mascot-svg').dataset.gait"),"run");
    assert.ok(await evaluate("document.querySelector('.mascot-svg').getAnimations({subtree:true}).length > 0"));
    assert.equal(await evaluate("document.querySelector('.mascot-svg').dataset.facing"), "left");
    petWindow.webContents.sendInputEvent({type:"keyUp",keyCode:"LEFT"});
    await until(() => evaluate("document.querySelector('.mascot-svg').dataset.gait === 'idle'"));
    await toggleAndWait(); assert.equal(petWindow.isVisible(),false);
    await toggleAndWait(); assert.equal(petWindow.isVisible(),true);
    showChat();
    await evaluate("document.querySelector('#message').value='keep draft'");
    await js("document.querySelector('[data-id=blue-one-eye]').click()");
    await until(() => js("!document.querySelector('#apply').disabled"));
    await js("document.querySelector('#apply').click()");
    await until(() => evaluate("document.querySelector('.mascot-svg').dataset.character === 'blue-one-eye'"));
    assert.equal(getRuntime().state.chatOpen, true);
    assert.equal(await evaluate("document.querySelector('#message').value"), "keep draft");
    restorePetFrame(); setMode("beans");
    await until(() => getRuntime().gameWindow?.isVisible());
    const gameWindow = getRuntime().gameWindow;
    const gameJs = code => gameWindow.webContents.executeJavaScript(code);
    await until(() => gameJs("Boolean(document.querySelector('.mascot-svg'))"));
    await gameJs("import('./game.js').then(({game})=>{game.score=7;game.level=2;game.pet.speed=364;window.savedGame=game;window.savedPellets=JSON.stringify(game.pellets);})");
    await js("document.querySelector('[data-id=black-cat]').click()");
    await until(() => js("!document.querySelector('#apply').disabled"));
    await js("document.querySelector('#apply').click()");
    await until(() => gameJs("document.querySelector('.mascot-svg').dataset.character === 'black-cat'"));
    assert.equal(getRuntime().gameWindow, gameWindow);
    assert.deepEqual(await gameJs("[savedGame.score,savedGame.level,savedGame.pet.speed,JSON.stringify(savedGame.pellets)===savedPellets]"),[7,2,364,true]);
    assert.equal(await gameJs("document.querySelectorAll('.character-lid').length"),0);
    assert.equal(await gameJs("document.querySelectorAll('.cat-pupils circle').length"),2);
    win.show(); await until(() => win.isVisible());
    await writeFile(path.resolve("work/character-library.png"),(await win.webContents.capturePage()).toPNG());
    await js("document.querySelector('[data-id=blue-one-eye]').click()");
    await until(() => js("!document.querySelector('#apply').disabled"));
    await js("document.querySelector('#apply').click()");
    await until(() => gameJs("document.querySelector('.mascot-svg').dataset.character === 'blue-one-eye'"));
    assert.equal(await gameJs("document.querySelectorAll('.character-lid').length"),0);
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.affection span'),node=>node.textContent)"), ["♥","♥","♥"]);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.affection span')).color"), "rgb(110, 137, 241)");
    win.close(); await until(() => !getRuntime().characterWindow); setMode("pet");
  });
  await check("Character import: native picker boundary, real worker conversion, confirm, reopen and removal", ["character", "import", "focus"], async () => {
    const originalPicker = dialog.showOpenDialog;
    const originalMessageBox = dialog.showMessageBox;
    let pickerCalls = 0, closePrompts = 0, rightsPrompts = 0, rightsAllowed = false;
    let picked = process.env.BLUEPET_TEST_CHARACTER_IMAGE
      ? path.resolve(process.env.BLUEPET_TEST_CHARACTER_IMAGE)
      : path.resolve("assets/characters/black-cat/source.png");
    dialog.showOpenDialog = async () => { pickerCalls++; return picked ? {canceled:false,filePaths:[picked]} : {canceled:true,filePaths:[]}; };
    dialog.showMessageBox = async (_owner, options) => {
      if (options.defaultId === 1 && options.cancelId === 1) {
        rightsPrompts++;
        return { response: rightsAllowed ? 0 : 1 };
      }
      closePrompts++;
      return { response: 0 };
    };
    try {
      getRuntime().trayMenu.getMenuItemById("characters").click();
      await until(() => getRuntime().characterWindow?.isVisible());
      const win = getRuntime().characterWindow, js = code => win.webContents.executeJavaScript(code);
      await until(() => js("document.body.dataset.ready === 'true'"));
      assert.equal(await js("window.characterLibrary.generate({id:'blue-one-eye'}).then(result=>result.ok)"), false, "built-in characters must be rejected by the generation IPC boundary");
      await js("document.querySelector('#choose').click()");
      await until(() => js("document.body.getAttribute('aria-busy') === 'false'"));
      assert.equal(rightsPrompts, 1);
      assert.equal(pickerCalls, 0, "declining the rights confirmation must stop before the native picker");
      rightsAllowed = true;
      await js("document.querySelector('#choose').click()");
      await until(() => js("!document.querySelector('#draft-fields').hidden || document.querySelector('#status').dataset.error === 'true'"), 12000);
      assert.equal(await js("document.querySelector('#status').dataset.error"), "false", await js("document.querySelector('#status').textContent"));
      const callsBeforeGuard = pickerCalls;
      await js("window.confirm=()=>false;document.querySelector('#choose').click()");
      await delay(80);
      assert.equal(pickerCalls, callsBeforeGuard, "reimport guard must run before native picker");
      assert.equal(await js("document.querySelector('#selection-status').textContent.includes('不会覆盖')"), true);
      await delay(80); win.close();
      await until(() => closePrompts === 1);
      assert.equal(win.isDestroyed(), false); assert.equal(win.isVisible(), true);
      assert.equal(await js("document.querySelector('#draft-fields').hidden"), false);
      assert.equal(await evaluate("document.querySelector('.mascot-svg').dataset.character"), "blue-one-eye");
      await js("document.querySelector('button[data-gait=walk]').click()");
      await until(() => js("document.querySelector('#desktop .mascot-svg').getAnimations({subtree:true}).length > 0"));
      await js("document.querySelector('#pause').click()");
      assert.equal(await js("document.querySelector('#desktop .mascot-svg').getAnimations({subtree:true}).length"),0);
      await js("document.querySelector('#pause').click()");
      await until(() => js("document.querySelector('#desktop .mascot-svg').getAnimations({subtree:true}).length > 0"));
      await js("document.querySelector('button[data-gait=idle]').click();document.querySelector('#character-name').value='桌面测试角色'");
      assert.equal(await js("document.querySelector('#apply').getBoundingClientRect().bottom <= innerHeight"),true);
      await writeFile(path.resolve("work/character-import.png"),(await win.webContents.capturePage()).toPNG());
      const fullSize = win.getSize(); win.setSize(720,620);
      await until(() => js("innerWidth === 720"));
      assert.equal(await js("document.querySelector('#apply').getBoundingClientRect().bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth"),true);
      await writeFile(path.resolve("work/character-library-small.png"),(await win.webContents.capturePage()).toPNG());
      win.setSize(...fullSize);
      await js("document.querySelector('#apply').click()");
      await until(() => evaluate("document.querySelector('.mascot-svg').dataset.character.startsWith('local-')"));
      const importedId = await evaluate("document.querySelector('.mascot-svg').dataset.character");
      const {readFile} = await import('node:fs/promises');
      const stored = JSON.parse(await readFile(path.join(app.getPath('userData'),'characters-v2.json'),'utf8'));
      assert.equal(stored.selected,importedId); assert.equal(stored.items[0].name,'桌面测试角色');
      assert.equal(stored.version,2); assert.equal("profile" in stored.items[0],false);
      assert.equal((await js("window.characterLibrary.source("+JSON.stringify(importedId)+").then(r=>r.value.profile.persona.archetype)")),'proud');
      assert.deepEqual(stored.items[0].analysis.parts.map(part=>part.kind),['body','eye']);
      assert.equal(stored.items[0].svg,await js("window.characterLibrary.source("+JSON.stringify(importedId)+").then(r=>r.value.svg)"));
      await js("document.querySelector('#edit').click()");
      await until(() => js("!document.querySelector('#draft-fields').hidden && document.querySelector('#apply').textContent === '保存修改'"));
      assert.equal(await js("!document.querySelector('#generation-tools').hidden"), true);
      assert.equal(await js("document.querySelector('#generation-instruction').maxLength"), 300);
      assert.deepEqual(await js("[getComputedStyle(document.documentElement).overscrollBehavior,getComputedStyle(document.body).overscrollBehavior,getComputedStyle(document.querySelector('.detail')).overscrollBehaviorY]"), ["none","none","none"]);
      assert.equal(await js("!document.querySelector('[data-i18n=generationHint]') && !document.querySelector('[data-i18n=generationPrivacy]')"), true);
      assert.equal(await js("(()=>{const root=document.documentElement,old=root.dataset.theme;root.dataset.theme='dark';const color=getComputedStyle(document.querySelector('#generation-instruction'),'::placeholder').color;root.dataset.theme=old;return color})()"), "rgb(174, 186, 219)");
      assert.deepEqual(await js("Array.from(document.querySelectorAll('[data-generate-scope]'),button=>button.dataset.generateScope)"), ["all","persona","dialogue","dialogue:headpat","dialogue:tickle","dialogue:poke","dialogue:cuddle","dialogue:nuzzle","dialogue:hop","dialogue:shy","easterEgg","parts"]);
      await js("document.querySelector('#generation-instruction').value='__missing_provider__';document.querySelector('[data-generate-scope=persona]').click()");
      await until(() => js("!document.querySelector('#generation-settings').hidden && document.body.getAttribute('aria-busy') === 'false'"));
      assert.equal(await js("document.querySelector('#generation-settings').textContent"), "请先前往聊天设置添加兼容接口");
      await writeFile(path.resolve("work/character-generation-missing-provider.png"),(await win.webContents.capturePage()).toPNG());
      await js("document.querySelector('#generation-settings').click()");
      await until(() => getRuntime().settingsWindow?.isVisible());
      getRuntime().settingsWindow.close(); await until(() => !getRuntime().settingsWindow);
      await js("document.querySelector('#generation-instruction').value='台词更机灵，但保持克制';document.querySelector('[data-generate-scope=\"dialogue\\:headpat\"]').click()");
      await until(() => js("!document.querySelector('#generation-proposal').hidden && document.body.getAttribute('aria-busy') === 'false'"));
      assert.deepEqual(await js("[document.querySelector('[data-dialogue=headpat]').value,document.querySelector('#generation-diff').textContent.includes('AI 生成的 headpat 台词')]"), ["只是刚好没躲｜再摸一下也不是不行｜第三句｜第四句",true]);
      await writeFile(path.resolve("work/character-generation-proposal.png"),(await win.webContents.capturePage()).toPNG());
      win.setSize(720,620); await until(() => js("innerWidth === 720"));
      assert.equal(await js("document.documentElement.scrollWidth <= innerWidth && document.querySelector('#apply').getBoundingClientRect().bottom <= innerHeight"), true);
      await writeFile(path.resolve("work/character-generation-proposal-small.png"),(await win.webContents.capturePage()).toPNG());
      win.setSize(...fullSize); await until(() => js("innerWidth === "+fullSize[0]));
      await js("document.querySelector('#adopt-suggestion').click()");
      await until(() => js("document.querySelector('[data-dialogue=headpat]').value === 'AI 生成的 headpat 台词｜第二句｜第三句｜第四句' && document.body.getAttribute('aria-busy') === 'false'"));
      await js("document.querySelector('#character-name').value='改名后的测试角色';document.querySelector('[data-dialogue=nuzzle]').value='编辑后的贴贴';document.querySelector('#apply').click()");
      await until(() => js("document.querySelector('#name').textContent === '改名后的测试角色'"));
      const editedStored = JSON.parse(await readFile(path.join(app.getPath('userData'),'characters-v2.json'),'utf8'));
      assert.equal(editedStored.items[0].name,'改名后的测试角色');
      assert.deepEqual(editedStored.items[0].analysis.dialogue.headpat,['AI 生成的 headpat 台词','第二句','第三句','第四句']);
      assert.equal(editedStored.items[0].analysis.dialogueTranslations.en,undefined);
      assert.deepEqual(editedStored.items[0].analysis.dialogue.nuzzle,['编辑后的贴贴']);
      assert.equal((await js("window.characterLibrary.import({name:'attack',svg:'<svg onload=\"alert(1)\"/>'})")).ok,false);
      const {default:sharp} = await import('sharp');
      picked = path.resolve('work/character-import-fixture.jpg');
      await sharp(path.resolve('assets/characters/black-cat/source.png')).jpeg({quality:95}).toFile(picked);
      await js("document.querySelector('#choose').click()");
      await until(() => js("!document.querySelector('#draft-fields').hidden || document.querySelector('#status').dataset.error === 'true'"),12000);
      assert.equal(await js("document.querySelector('#status').dataset.error"),'false',await js("document.querySelector('#status').textContent"));
      await js("document.querySelector('#cancel').click()");
      await until(() => js("document.querySelector('#draft-fields').hidden && document.body.getAttribute('aria-busy') === 'false'"));
      assert.equal(JSON.parse(await readFile(path.join(app.getPath('userData'),'characters-v2.json'),'utf8')).items.length,1,"discarded JPG draft is not saved");
      picked = path.resolve('assets/blue-one-eye-mascot.svg');
      await js("document.querySelector('#choose').click()");
      await until(() => js("document.querySelector('#status').dataset.error === 'true'"));
      assert.equal(await evaluate("document.querySelector('.mascot-svg').dataset.character"),importedId);
      picked = null;
      await js("document.querySelector('#choose').click()");
      await until(() => js("document.body.getAttribute('aria-busy') === 'false'"));
      win.close(); await until(() => !getRuntime().characterWindow);
      getRuntime().trayMenu.getMenuItemById('characters').click();
      await until(() => getRuntime().characterWindow?.isVisible());
      const reopened = code => getRuntime().characterWindow.webContents.executeJavaScript(code);
      await until(() => reopened("document.body.dataset.ready === 'true'"));
      assert.equal(await reopened("document.querySelector('#name').textContent"),'改名后的测试角色');
      await reopened("window.confirm=()=>true;document.querySelector('#remove').click()");
      await until(() => evaluate("document.querySelector('.mascot-svg').dataset.character === 'blue-one-eye'"));
      assert.equal(JSON.parse(await readFile(path.join(app.getPath('userData'),'characters-v2.json'),'utf8')).items.length,0);
      getRuntime().characterWindow.close(); await until(() => !getRuntime().characterWindow);
    } finally { dialog.showOpenDialog = originalPicker; dialog.showMessageBox = originalMessageBox; }
  });
  await (await import("./character-generation-test.mjs")).characterGenerationChecks({ getRuntime, until, check });
  await check("Character color import: raster normalization, editable analysis and live use", ["character", "import", "focus"], async () => {
    const originalPicker = dialog.showOpenDialog;
    const originalMessageBox = dialog.showMessageBox;
    const { default: sharp } = await import("sharp");
    const fixture = path.resolve("work/character-color-fixture.png");
    await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">
      <rect width="240" height="240" fill="#f7f7f2"/>
      <path d="M62 202V88Q62 54 96 54H144Q178 54 178 88V202Z" fill="#ffd45a"/>
      <path d="M72 72L84 28L108 61M168 72L156 28L132 61" fill="#ffb46f"/>
      <circle cx="98" cy="105" r="12" fill="#fff0a6"/><circle cx="142" cy="105" r="12" fill="#fff0a6"/>
      <circle cx="101" cy="106" r="5" fill="#ff8f70"/><circle cx="145" cy="106" r="5" fill="#ff8f70"/>
      <path d="M178 150Q220 130 205 96" fill="none" stroke="#ffd45a" stroke-width="18" stroke-linecap="round"/>
    </svg>`)).png().toFile(fixture);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
    dialog.showMessageBox = async () => ({ response: 0 });
    try {
      if (getRuntime().state.manualHidden) await toggleAndWait();
      setMode("pet");
      getRuntime().trayMenu.getMenuItemById("characters").click();
      await until(() => getRuntime().characterWindow?.isVisible());
      const win = getRuntime().characterWindow, js = code => win.webContents.executeJavaScript(code);
      await until(() => js("document.body.dataset.ready === 'true'"));
      await js("document.querySelector('#choose').click()");
      await until(() => js("!document.querySelector('#draft-fields').hidden || document.querySelector('#status').dataset.error === 'true'"), 12000);
      assert.equal(await js("document.querySelector('#status').dataset.error"), "false", await js("document.querySelector('#status').textContent"));
      assert.equal(await js("document.querySelector('#large image')?.getAttribute('href').startsWith('data:image/png;base64,')"), true);
      await until(async () => yellowPixels(await win.webContents.capturePage()) > 500);
      assert.ok(yellowPixels(await win.webContents.capturePage()) > 500, "彩色角色预览应渲染真实黄色像素，而不是破图图标");
      assert.deepEqual(await js("[document.querySelectorAll('.imported-eye-masks ellipse').length,document.querySelectorAll('.imported-pupils circle').length]"), [6, 6], "三种预览尺寸都应遮住两枚固定瞳孔并换成可移动瞳孔");
      assert.equal(await js("document.querySelectorAll('.character-gait-raster').length"), 3, "无腿彩色角色的三个预览尺寸都应绑定下轮廓位移");
      await js("document.querySelector('button[data-gait=run]').click()");
      await until(() => js("Math.abs(Number(document.querySelector('#large .character-gait-displacement').getAttribute('scale'))) > .5"));
      await writeFile(path.resolve("work/character-color-raster-gait.png"), (await win.webContents.capturePage()).toPNG());
      await js("document.querySelector('button[data-gait=idle]').click()");
      assert.equal(await js("document.querySelector('#large .character-gait-displacement').getAttribute('scale')"), "0");
      await writeFile(path.resolve("work/character-color-import.png"), (await win.webContents.capturePage()).toPNG());
      assert.deepEqual(await js("Array.from(document.querySelectorAll('.part-row select'),select=>select.value)"), ["body", "eye"]);
      await js(`document.querySelector('#character-name').value='彩色测试角色';
        document.querySelector('#persona-archetype').value='cheerful';
        document.querySelector('#persona-voice').value='bright';
        document.querySelector('#persona-identity').value='彩色桌面伙伴';
        document.querySelector('#persona-summary').value='开朗又爱回应。';
        document.querySelector('#persona-traits').value='开朗、亲近';
        document.querySelector('[data-dialogue=nuzzle]').value='来贴贴吧｜我会接住你';
        document.querySelector('#egg-label').value='尾巴暗号';
        document.querySelector('#egg-trigger').value='nuzzle';
        document.querySelector('#egg-description').value='连续贴贴三次会亮出暗号。';
        document.querySelector('#egg-message').value='暗号对上啦';
        document.querySelector('#add-part').click();
        document.querySelectorAll('.part-row select')[2].value='tail';
        document.querySelector('#apply').click();`);
      await until(() => evaluate("document.querySelector('.mascot-svg').dataset.character.startsWith('local-')"));
      const id = await evaluate("document.querySelector('.mascot-svg').dataset.character");
      assert.ok(yellowPixels(await getRuntime().petWindow.webContents.capturePage()) > 100, "桌面角色应渲染内嵌彩色图片");
      assert.equal(await evaluate("document.querySelectorAll('.imported-pupils circle').length"), 2, "导入角色应从宽眼睛框生成一对运行时瞳孔");
      assert.equal(await evaluate("document.querySelectorAll('.imported-eye-masks ellipse').length"), 2, "桌面角色应遮住原图固定瞳孔");
      win.hide(); await until(() => !win.isVisible());
      const petWindow = getRuntime().petWindow;
      const realCursor = screen.getCursorScreenPoint;
      try {
        await evaluate("window.bluepet.setPetHover(true)");
        await until(() => getRuntime().petHovered);
        const frame = petWindow.getBounds();
        screen.getCursorScreenPoint = () => ({ x: frame.x + frame.width / 2, y: frame.y - 80 });
        await until(() => evaluate("parseFloat(document.querySelector('.mascot-svg').style.getPropertyValue('--gaze-y')) < -1"));
      } finally {
        screen.getCursorScreenPoint = realCursor;
        await evaluate("window.bluepet.setPetHover(false)");
      }
      await focusWindow(petWindow);
      petWindow.webContents.sendInputEvent({type:"keyDown",keyCode:"LEFT"}); await delay(100);
      assert.equal(await evaluate("document.querySelector('.mascot-svg').dataset.facing"), "left");
      await until(() => evaluate("Math.abs(Number(document.querySelector('.character-gait-displacement').getAttribute('scale'))) > .5"));
      petWindow.webContents.sendInputEvent({type:"keyUp",keyCode:"LEFT"});
      await until(() => evaluate("document.querySelector('.mascot-svg').dataset.gait === 'idle'"));
      assert.equal(await evaluate("document.querySelector('.mascot-svg').dataset.facing"), "left", "静止时保留最后朝向");
      petWindow.webContents.sendInputEvent({type:"keyDown",keyCode:"RIGHT"}); await delay(100);
      assert.equal(await evaluate("document.querySelector('.mascot-svg').dataset.facing"), "right");
      petWindow.webContents.sendInputEvent({type:"keyUp",keyCode:"RIGHT"});
      await until(() => evaluate("document.querySelector('.mascot-svg').dataset.gait === 'idle'"));
      assert.equal(await evaluate("document.querySelector('.mascot-svg').dataset.looking"), "true", "Pet 中导入角色也应持续看向光标");
      const { readFile } = await import("node:fs/promises");
      const stored = JSON.parse(await readFile(path.join(app.getPath("userData"), "characters-v2.json"), "utf8"));
      assert.equal(stored.items[0].svg.includes("data:image/png;base64,"), true);
      assert.equal("profile" in stored.items[0], false);
      assert.equal((await evaluate("document.querySelector('.mascot-svg').style.getPropertyValue('--body-origin-y')")) !== "", true);
      assert.deepEqual(stored.items[0].analysis.parts.map(part => part.kind), ["body", "eye", "tail"]);
      assert.deepEqual(stored.items[0].analysis.dialogue.nuzzle, ["来贴贴吧", "我会接住你"]);
      assert.equal(stored.items[0].analysis.easterEgg.label, "尾巴暗号");
      assert.equal(await js(`window.characterLibrary.source(${JSON.stringify(id)}).then(r=>r.value.profile.easterEgg.reaction.messages[0])`), "暗号对上啦");
      await until(() => evaluate(`document.querySelector('#pet').dataset.hideCharacter === ${JSON.stringify(id)}`));
      win.close(); await until(() => !getRuntime().characterWindow);
      getRuntime().trayMenu.getMenuItemById("characters").click();
      await until(() => getRuntime().characterWindow?.isVisible());
      await until(() => getRuntime().characterWindow.webContents.executeJavaScript("document.body.dataset.ready === 'true'"));
      await getRuntime().characterWindow.webContents.executeJavaScript("window.confirm=()=>true;document.querySelector('#remove').click()");
      await until(() => evaluate("document.querySelector('.mascot-svg').dataset.character === 'blue-one-eye'"));
      getRuntime().characterWindow.close(); await until(() => !getRuntime().characterWindow);
    } finally { dialog.showOpenDialog = originalPicker; dialog.showMessageBox = originalMessageBox; }
  });
  await check("API settings: tray entry, isolated window, encrypted save, reopen and clear", ["smoke", "settings", "chat"], async () => {
    const items = getRuntime().trayMenu.items;
    assert.equal(items[items.findIndex(item => item.id === "quit") - 1].id, "api-settings");
    setMode("pet");
    await toggleAndWait();
    assert.equal(getRuntime().state.manualHidden, true);
    getRuntime().trayMenu.getMenuItemById("api-settings").click();
    await until(() => getRuntime().settingsWindow?.isVisible());
    const win = getRuntime().settingsWindow;
    const js = code => win.webContents.executeJavaScript(code);
    await until(() => js("!document.querySelector('fieldset').disabled"));
    assert.equal(getRuntime().state.manualHidden, true);
    assert.equal(getRuntime().petWindow.isVisible(), false);
    assert.equal(win.isAlwaysOnTop(), false, "聊天设置不应挡住其他应用");
    getRuntime().trayMenu.getMenuItemById("api-settings").click();
    assert.equal(getRuntime().settingsWindow, win);
    const prefs = win.webContents.getLastWebPreferences();
    assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
    assert.equal(await js("typeof window.bluepet"), "undefined");
    await js("document.querySelector('#api-key').value='selection-test'; document.querySelector('#api-key').focus()");
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["meta"] });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["meta"] });
    await until(() => js("document.querySelector('#api-key').selectionEnd === 14 && document.querySelector('#api-key').selectionStart === 0"));
    await js("document.querySelector('#base-url').value='http://models.example'; document.querySelector('#api-key').value='desktop-fake-key'; document.querySelector('#chat-model').value='chat-model'; document.querySelector('form').requestSubmit()");
    await until(() => js("document.querySelector('#status').dataset.error === 'true'"));
    assert.equal(await js("document.querySelector('#api-key').value"), "desktop-fake-key", "保存失败时不能清空待修正的密钥");
    assert.equal(await js("document.body.getAttribute('aria-busy')"), "false");
    await js("document.querySelector('#base-url').value='https://models.example/anthropic'; document.querySelector('#api-key').value='desktop-fake-key'; document.querySelector('#chat-model').value='chat-model'; document.querySelector('#vision-model').value='vision-model'; document.querySelector('form').requestSubmit()");
    await until(() => js("document.querySelector('#status').textContent.includes('已保存，下次聊天生效')"));
    assert.equal(await js("document.querySelector('#api-key').value"), "");
    const { readFile } = await import("node:fs/promises");
    assert.ok(!(await readFile(path.join(app.getPath("userData"), "api-settings.enc"))).includes(Buffer.from("desktop-fake-key")));
    await writeFile(path.resolve("work/api-settings.png"), (await win.webContents.capturePage()).toPNG());
    await js("window.apiSettings.close()"); await until(() => !getRuntime().settingsWindow);
    getRuntime().trayMenu.getMenuItemById("api-settings").click();
    await until(() => getRuntime().settingsWindow?.isVisible());
    const reopened = code => getRuntime().settingsWindow.webContents.executeJavaScript(code);
    await until(() => reopened("document.querySelector('#api-key').placeholder.includes('已保存')"));
    assert.equal(await reopened("document.querySelector('#api-key').value"), "");
    await reopened("window.confirm=()=>true; document.querySelector('#clear').click()");
    await until(() => reopened("document.querySelector('#status').textContent.includes('已清除')"));
    assert.equal(await reopened("document.querySelector('#api-key').required"), true);
    await reopened("document.querySelector('#cancel').click()"); await until(() => !getRuntime().settingsWindow);
    await toggleAndWait();
    setMode("beans");
    await until(() => getRuntime().gameWindow?.isVisible());
    getRuntime().trayMenu.getMenuItemById("api-settings").click();
    await until(() => getRuntime().settingsWindow?.isFocused());
    assert.equal(getRuntime().state.mode, "beans");
    assert.equal(getRuntime().settingsWindow.isAlwaysOnTop(), false);
    getRuntime().settingsWindow.close();
    setMode("pet");
  });
  await check("renderer preserves original SVG geometry inside standard motion layers", ["smoke", "renderer", "character"], async()=>{
    setMode("pet"); await delay(150);
    const original = await evaluate("window.bluepet.loadMascot()");
    const originalBody=original.match(/class="body" d="([^"]+)"/)[1];
    assert.equal(await evaluate("document.querySelector('path.body').getAttribute('d')"),originalBody);
    const structure=await evaluate("Array.from(document.querySelector('.mascot-svg').querySelectorAll('*'),e=>({tag:e.tagName,runtime:e.classList.contains('character-facing')||e.classList.contains('character-content')})).filter(e=>!e.runtime).map(e=>e.tag)");
    const baseline=await evaluate("Array.from(new DOMParser().parseFromString("+JSON.stringify(original)+",'image/svg+xml').documentElement.querySelectorAll('*'),e=>e.tagName)");
    assert.deepEqual(structure,baseline);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.pet')).width"),"84px");
    await writeFile(path.resolve("work/original-idle.png"),(await getRuntime().petWindow.webContents.capturePage()).toPNG());
  });
  await check("Character bindings: basic SVG, independent reactions and atomic remount cleanup", ["character", "renderer"], async () => {
    setMode("pet");
    await until(() => !getRuntime().modeTransition, 7000);
    await evaluate(`(async () => {
      const { mountCharacter } = await import('./character.js');
      const { BASIC_SVG, BLUE_ONE_EYE } = await import('../characters.js');
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;width:84px;height:84px;left:0;top:0';
      document.body.append(host);
      const original = document.querySelector('.mascot-svg');
      const parse = () => document.importNode(new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="20" fill="#ec9640"/></svg>',
        'image/svg+xml').documentElement, true);
      const ensure = (value, message) => { if (!value) throw new Error(message); };
      let first, second;
      try {
        first = mountCharacter(host, parse(), BASIC_SVG);
        first.motion({ gait: 'walk' });
        const root = first.svg.querySelector('.character-root');
        const animation = root.getAnimations()[0];
        ensure(animation, 'generic gait must animate a real SVG without anatomy');
        await new Promise(resolve => setTimeout(resolve, 90));
        ensure(new DOMMatrix(getComputedStyle(root).transform).m42 < 0, 'generic gait changes the actual transform');
        first.motion({ gait: 'walk' });
        ensure(root.getAnimations()[0] === animation, 'same gait must not restart');
        first.reset();
        const before = original.dataset.reaction;
        first.react('poke');
        ensure(getComputedStyle(root).animationName === 'poke', 'generic SVG gets the shared reaction');
        ensure(original.dataset.reaction === before, 'preview reaction must not change the desktop pet');
        first.react(null);
        first.motion({ gait: 'run' });
        let rejected = false;
        try { mountCharacter(host, parse(), BLUE_ONE_EYE); } catch { rejected = true; }
        ensure(rejected && host.firstChild === first.svg, 'invalid binding preserves the working character');
        second = mountCharacter(host, parse(), BASIC_SVG);
        ensure(first.svg.dataset.active === 'false', 'replaced controller is disposed');
        first.motion({ gait: 'walk' }); first.react('hop');
        ensure(first.svg.dataset.reaction === undefined, 'old controller cannot restart a reaction');
        second.react('hop');
        ensure(getComputedStyle(second.svg.querySelector('.character-root')).animationName === 'happy-hop', 'replacement supports reactions');
        second.destroy();
        ensure(second.svg.getAnimations().length === 0, 'destroy cancels CSS and JS animation');
      } finally { first?.destroy(); second?.destroy(); host.remove(); }
    })()`);
  });
  await check("Character motion: reduced preference before creation and live changes for both bindings", ["character", "motion"], async () => {
    setMode("pet");
    const win = getRuntime().petWindow;
    win.webContents.debugger.attach("1.3");
    const media = value => win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value }],
    });
    try {
      await media("reduce");
      await evaluate(`(async () => {
        const { mountCharacter } = await import('./character.js');
        const { BASIC_SVG, BLUE_ONE_EYE } = await import('../characters.js');
        const source = await window.bluepet.loadMascot();
        window.characterFixtures = [];
        for (const definition of [BLUE_ONE_EYE, BASIC_SVG]) {
          const host = document.createElement('div');
          host.style.cssText = 'position:absolute;width:84px;height:84px;left:0;top:0';
          document.body.append(host);
          const svg = document.importNode(new DOMParser().parseFromString(
            definition === BLUE_ONE_EYE ? source : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="20"/></svg>',
            'image/svg+xml').documentElement, true);
          const character = mountCharacter(host, svg, definition);
          window.characterFixtures.push({ host, character });
          character.motion({ gait: 'run' }); character.react('headpat');
        }
      })()`);
      const animationCounts = () => evaluate("window.characterFixtures.map(({character})=>character.svg.getAnimations({subtree:true}).length)");
      assert.deepEqual(await animationCounts(), [0, 0], "preference is read at creation");
      await media("no-preference");
      await until(() => evaluate("!matchMedia('(prefers-reduced-motion: reduce)').matches"));
      await until(async () => (await animationCounts()).every(count => count > 0));
      await evaluate("window.characterFixtures[0].character.react('shy')");
      assert.ok(await evaluate("window.characterFixtures[0].character.svg.querySelector('.lid').getAnimations().length > 0"));
      await media("reduce");
      await until(() => evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"));
      await until(async () => (await animationCounts()).every(count => count === 0));
      assert.equal(await evaluate("new DOMMatrix(getComputedStyle(window.characterFixtures[0].character.svg.querySelector('.lid')).transform).m42"), -20);
    } finally {
      await evaluate("window.characterFixtures?.forEach(({host,character})=>{character.destroy();host.remove();});delete window.characterFixtures");
      await media("no-preference");
      win.webContents.debugger.detach();
    }
  });
  await check("Mode inertia: smooth launch, momentum on return/reversal, settling and chat cancellation", ["motion", "mode"], async()=>{
    setMode("pet");await until(()=>!getRuntime().modeTransition,7000);
    const realCursor=screen.getCursorScreenPoint,realAnimations=systemPreferences.getAnimationSettings;
    const area=screen.getDisplayMatching(getRuntime().petWindow.getBounds()).workArea;
    screen.getCursorScreenPoint=()=>({x:area.x+30,y:area.y+30});
    systemPreferences.getAnimationSettings=()=>({...realAnimations.call(systemPreferences),prefersReducedMotion:false});
    try {
      const home=getRuntime().position;
      setMode("dodge");assert.deepEqual(getRuntime().position,home);
      assert.deepEqual(getRuntime().velocity,{x:0,y:0});
      await delay(45);assert.ok(Math.hypot(...Object.values(getRuntime().velocity))<30);
      await delay(1500);
      const before=getRuntime().position,momentum=getRuntime().velocity;
      assert.ok(Math.hypot(before.x-home.x,before.y-home.y)>15);
      setMode("pet");assert.deepEqual(getRuntime().position,before);assert.deepEqual(getRuntime().velocity,momentum);
      await delay(100);
      const turning=getRuntime().position,turnVelocity=getRuntime().velocity;
      setMode("dodge");assert.deepEqual(getRuntime().position,turning);assert.deepEqual(getRuntime().velocity,turnVelocity);
      await delay(120);setMode("pet");
      await until(()=>!getRuntime().modeTransition,7000);
      assert.ok(Math.hypot(getRuntime().position.x-home.x,getRuntime().position.y-home.y)<1);
      assert.deepEqual(getRuntime().velocity,{x:0,y:0});await visiblePixels();
      setMode("dodge");await delay(500);setMode("pet");showChat();
      const paused=getRuntime().position;await delay(150);
      assert.equal(getRuntime().modeTransition,undefined);assert.deepEqual(getRuntime().position,paused);
      restorePetFrame();
    } finally {screen.getCursorScreenPoint=realCursor;systemPreferences.getAnimationSettings=realAnimations;}
  });
  await check("Motion cadence: native Dodge and Pet return window updates", ["motion", "dodge", "pet"], async()=>{
    setMode("pet");await until(()=>!getRuntime().modeTransition,7000);
    const win=getRuntime().petWindow,origin=getRuntime().position,area=screen.getDisplayMatching(win.getBounds()).workArea;
    const target={x:area.x+area.width/2-66,y:area.y+area.height/2-66};
    for(const request of [{phase:"start",point:origin},{phase:"move",point:target},{phase:"end"}]) {
      await evaluate("window.bluepet.dragPet("+JSON.stringify(request)+")");await delay(30);
    }
    const realCursor=screen.getCursorScreenPoint,realPosition=win.setPosition,realAnimations=systemPreferences.getAnimationSettings;
    screen.getCursorScreenPoint=()=>({x:getRuntime().position.x+140,y:getRuntime().position.y+66});
    systemPreferences.getAnimationSettings=()=>({...realAnimations.call(systemPreferences),prefersReducedMotion:false});
    let samples=[];
    win.setPosition=function(...args) {samples.push(performance.now());return realPosition.apply(this,args);};
    const report=label=>{
      const gaps=samples.slice(1).map((time,i)=>time-samples[i]).sort((a,b)=>a-b);
      const hz=(samples.length-1)*1000/(samples.at(-1)-samples[0]);
      console.log("Native cadence:",JSON.stringify({label,updates:samples.length,hz:Math.round(hz),p95ms:Math.round(gaps[Math.floor(gaps.length*.95)])}));
      if(!process.env.BLUEPET_PROFILE_BASELINE)assert.ok(hz>45,label+" should exceed the former 31Hz clock");
    };
    try {
      setMode("dodge");await delay(1400);samples=[];await delay(450);report("dodge");
      setMode("pet");samples=[];await delay(450);report("pet-return");
      await until(()=>!getRuntime().modeTransition,7000);await visiblePixels();
    } finally {screen.getCursorScreenPoint=realCursor;win.setPosition=realPosition;systemPreferences.getAnimationSettings=realAnimations;}
  });
  await check("Dodge gaze: pupil tracks cursor during walking, chat, menu and restore", ["dodge", "gaze"], async()=>{
    const realCursor=screen.getCursorScreenPoint;
    let offset={x:400,y:0};
    const eyeCenter=()=>{
      const b=getRuntime().petWindow.getBounds();
      return {x:b.x+(b.width-84)/2+31/64*84,y:b.y+b.height-7-84+29.5/64*84};
    };
    screen.getCursorScreenPoint=()=>{const eye=eyeCenter();return {x:eye.x+offset.x,y:eye.y+offset.y};};
    const assertLook=async()=>{
      const length=Math.hypot(offset.x,offset.y);
      // Wait for an IPC/render frame, then verify the actual pupil transform.
      await until(async()=>{
        const actual=await evaluate(`(()=>{
          const svg=document.querySelector('.mascot-svg');
          const pupil=document.querySelector('.pupil');
          const transform=new DOMMatrix(getComputedStyle(pupil).transform);
          return {x:transform.m41+4,y:transform.m42+.3,facing:svg.dataset.facing};
        })()`);
        const facing=actual.facing==='left'?-1:1;
        return Math.abs(actual.x-(length?offset.x/length*4*facing:0))<.1 &&
          Math.abs(actual.y-(length?offset.y/length*4:0))<.1;
      },1000).catch(async error=>{
        const detail=await evaluate("(()=>{const s=document.querySelector('.mascot-svg'),t=new DOMMatrix(getComputedStyle(s.querySelector('.pupil')).transform);return {gaze:[s.style.getPropertyValue('--gaze-x'),s.style.getPropertyValue('--gaze-y')],actual:[t.m41+4,t.m42+.3],facing:s.dataset.facing,mode:document.body.dataset.mode,looking:s.dataset.looking};})()");
        throw new Error(error.message+JSON.stringify({offset,detail,state:getRuntime().state,velocity:getRuntime().velocity,menuOpen:getRuntime().menuOpen}));
      });
    };
    try {
      setMode("dodge");await delay(150);
      for(const direction of [{x:400,y:0},{x:0,y:400},{x:-400,y:0},{x:0,y:-400},{x:300,y:300}]) {
        offset=direction;await assertLook();
      }
      showChat();await delay(100);
      // These points are inside the speech surface: body stays still, eye follows.
      const before=getRuntime().petWindow.getBounds();
      offset={x:-60,y:-100};await assertLook();
      offset={x:60,y:-100};await assertLook();
      assert.deepEqual(getRuntime().petWindow.getBounds(),before);
      getRuntime().trayMenu.emit("menu-will-show",{});
      offset={x:0,y:300};await assertLook();
      offset={x:0,y:0};await assertLook();
      getRuntime().trayMenu.emit("menu-will-close",{});
      await toggleAndWait();offset={x:-300,y:200};await toggleAndWait();await assertLook();
      restorePetFrame();await assertLook();
    } finally {
      getRuntime().trayMenu.emit("menu-will-close",{});
      screen.getCursorScreenPoint=realCursor;setMode("pet");
    }
  });
  await check("Dodge chat: no wander, native avoidance, input stability, hit testing and bubble geometry", ["dodge", "chat", "focus"], async()=>{
    setMode("pet");await until(()=>!getRuntime().modeTransition,7000);
    // Drafts now survive closing the bubble; this typing check needs its own empty fixture.
    await evaluate("document.querySelector('#message').value=''");
    const win=getRuntime().petWindow,origin=getRuntime().position;
    const area=screen.getDisplayMatching(win.getBounds()).workArea;
    const target={x:area.x+area.width/2-66,y:area.y+area.height/2-66};
    for(const request of [{phase:"start",point:origin},{phase:"move",point:target},{phase:"end"}]) {
      await evaluate("window.bluepet.dragPet("+JSON.stringify(request)+")");await delay(40);
    }
    const realCursor=screen.getCursorScreenPoint;
    let cursor={x:area.x+10,y:area.y+10};
    screen.getCursorScreenPoint=()=>({...cursor});
    try {
      setMode("dodge");showChat();await delay(400);
      const resting=win.getBounds();await delay(600);assert.deepEqual(win.getBounds(),resting);
      assert.equal(getRuntime().ignoringMouse,true);
      const center={x:resting.x+136,y:resting.y+193};
      cursor={x:center.x+230,y:center.y};await delay(60);
      cursor={x:center.x+100,y:center.y};await delay(130);
      assert.ok(win.getBounds().x<resting.x-20,"expanded native chat window dodges the cursor");
      assert.deepEqual([win.getBounds().width,win.getBounds().height],[272,242]);
      cursor={x:area.x+10,y:area.y+10};await delay(1200);
      const settled=win.getBounds();await delay(400);assert.deepEqual(win.getBounds(),settled);
      cursor={x:settled.x+65,y:settled.y+122};await delay(100);
      assert.equal(getRuntime().ignoringMouse,false);
      win.webContents.sendInputEvent({type:"mouseDown",x:65,y:122,button:"left",clickCount:1});
      win.webContents.sendInputEvent({type:"mouseUp",x:65,y:122,button:"left",clickCount:1});
      await win.webContents.insertText("你好，呼噜呼噜");await delay(300);
      assert.equal(await evaluate("document.querySelector('#message').value"),"你好，呼噜呼噜");
      assert.deepEqual(win.getBounds(),settled,"typing does not chase the window");
      for(const text of ["悄悄说吧，我会小声回答。","呼".repeat(50),"a".repeat(50),"👨‍👩‍👧‍👦".repeat(50),"暂时没连上，请检查网络和本机 API 设置后再试。"]) {
        await evaluate("document.querySelector('#reply').textContent="+JSON.stringify(text));
        assert.ok(await evaluate(`(()=>{
          const input=document.querySelector('#message'),r=input.getBoundingClientRect();
          const bubble=document.querySelector('.speech').getBoundingClientRect();
          const reply=document.querySelector('#reply').getBoundingClientRect();
          return bubble.width===248&&bubble.height===140&&r.bottom<=bubble.bottom-12&&reply.bottom<=r.top-8&&
            [r.left+4,r.left+r.width/2,r.right-4].every(x=>document.elementFromPoint(x,r.top+r.height/2)===input)&&
            getComputedStyle(document.querySelector('.speech'),'::after').content==='none';
        })()`));
      }
      await evaluate("document.querySelector('#reply').textContent='悄悄说吧，我会小声回答。';document.querySelector('#message').value=''");
      await delay(80); // Let the native compositor paint the reset preview text.
      await writeFile(path.resolve("work/huluhulu-chat-compact.png"),(await win.webContents.capturePage()).toPNG());
      restorePetFrame();await delay(100);
      assert.equal(await evaluate("document.querySelector('.speech').inert"),true);
    } finally {screen.getCursorScreenPoint=realCursor;setMode("pet");}
  });
  await check("Hide particles: Pet, Dodge, chat and Eat Beans finish within 500ms and cancel safely", ["hide", "motion"], async()=>{
    const realAnimations=systemPreferences.getAnimationSettings;
    systemPreferences.getAnimationSettings=()=>({...realAnimations.call(systemPreferences),prefersReducedMotion:false});
    try {
      for(const mode of ["pet","dodge","chat","beans"]) {
        setMode(mode==="chat"?"pet":mode);if(mode==="chat")showChat();
        const win=mode==="beans"?getRuntime().gameWindow:getRuntime().petWindow;
        await until(()=>win.isVisible()&&!win.webContents.isLoading());
        await until(()=>win.webContents.executeJavaScript("Boolean(document.querySelector('.hide-particles'))"));
        await delay(100);
        const started=performance.now();toggleHidden();
        // Observe native visibility concurrently. Screenshot/PNG/disk latency
        // must not be included in the hide deadline.
        const hiddenAt = until(() => !win.isVisible(), 1500).then(() => performance.now());
        hiddenAt.catch(() => {}); // The awaited assertion below reports failures.
        assert.equal(getRuntime().state.manualHidden,true);
        await delay(120);assert.equal(win.isVisible(),true);
        assert.equal(await win.webContents.executeJavaScript("document.body.classList.contains('is-dissolving')"),true);
        const pixels=await win.webContents.executeJavaScript("(()=>{const c=document.querySelector('.hide-particles'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<p.length;i+=4)if(p[i])n++;return n;})()");
        assert.ok(pixels>20,"real particle pixels are rendered");
        if(mode==="pet") {
          await delay(80);
          const particlePng=await win.webContents.executeJavaScript("document.querySelector('.hide-particles').toDataURL('image/png')");
          await writeFile(path.resolve("work/huluhulu-hide.png"),Buffer.from(particlePng.split(',')[1],"base64"));
        }
        const elapsed=(await hiddenAt)-started;
        assert.ok(elapsed<500,"native hide deadline: "+elapsed);
        console.log("Hide duration:",mode,Math.round(elapsed),"ms");
        await delay(550);assert.equal(win.isVisible(),false,"watchdog must respect manual hide");
        toggleHidden();await delay(100);assert.equal(win.isVisible(),true);
        assert.equal(await win.webContents.executeJavaScript("document.body.classList.contains('is-dissolving')"),false);
        toggleHidden();await delay(100);toggleHidden();await delay(500);
        assert.equal(win.isVisible(),true,"old completion must not hide a restored pet");
      }
      setMode("pet");await delay(100);toggleHidden();await delay(80);showChat();await delay(500);
      assert.equal(getRuntime().petWindow.isVisible(),true);assert.equal(getRuntime().state.chatOpen,true);
      toggleHidden();await delay(80);setMode("dodge");await delay(500);
      assert.equal(getRuntime().petWindow.isVisible(),true);assert.equal(getRuntime().state.mode,"dodge");
    } finally {systemPreferences.getAnimationSettings=realAnimations;setMode("pet");}
  });
  await check("Hide reduced motion: startup preference and live changes skip particles", ["hide", "motion"], async()=>{
    setMode("pet");const win=getRuntime().petWindow;
    const realAnimations=systemPreferences.getAnimationSettings;
    systemPreferences.getAnimationSettings=()=>({...realAnimations.call(systemPreferences),prefersReducedMotion:false});
    win.webContents.debugger.attach("1.3");
    const media=value=>win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value}]});
    try {
      await media("reduce");win.reload();await delay(450);
      await until(()=>evaluate("Boolean(document.querySelector('.hide-particles'))"));
      toggleHidden();await until(()=>!win.isVisible(),300);toggleHidden();await delay(100);
      await media("no-preference");await until(()=>evaluate("!matchMedia('(prefers-reduced-motion: reduce)').matches"));toggleHidden();await delay(100);
      assert.equal(win.isVisible(),true);await media("reduce");
      await until(()=>evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"));
      await until(()=>!win.isVisible(),300);
      toggleHidden();await delay(100);assert.equal(win.isVisible(),true);
    } finally {await media("no-preference");win.webContents.debugger.detach();systemPreferences.getAnimationSettings=realAnimations;setMode("pet");}
  });
  await check("eye stays open by default under CSP, with only brief natural blinks", ["soak", "gaze", "motion"], async()=>{
    const eyeY=()=>evaluate("new DOMMatrix(getComputedStyle(document.querySelector('.lid')).transform).m42");
    // Previous checks may finish during a legitimate blink; begin the sampling
    // window once it finishes, retaining the duration/open-ratio assertions.
    await until(async()=>await eyeY()===-20,500);
    assert.equal(await eyeY(),-20);
    let samples=0,closed=0,closedSince=0,longest=0,captured=false,captureMs=0;
    const start=performance.now();
    while(performance.now()-start<8000) {
      const y=await eyeY(); samples++;
      if(y > -19) {
        closed++; if(!closedSince) closedSince=performance.now();
        if(!captured && y>0) {
          const captureStart=performance.now();
          await writeFile(path.resolve("work/brief-blink.png"),(await getRuntime().petWindow.webContents.capturePage()).toPNG());
          captureMs=performance.now()-captureStart;
          captured=true;
        }
      } else if(closedSince) { longest=Math.max(longest,performance.now()-closedSince);closedSince=0; }
      await delay(20);
    }
    console.log("Eye sampling:", {samples,closed,longest:Math.round(longest),captureMs:Math.round(captureMs)});
    assert.ok(closed>0,"an automatic blink occurs");
    assert.ok(closed/samples<.1,"fully open for over 90% of the time");
    assert.ok(longest<350,"no lingering half-closed lid");
  });
  await check("system-tinted outline menu-bar icon and plain quit item", ["menu", "appearance"], async () => {
    const icon = nativeImage.createFromPath(path.resolve("assets/tray.png"));
    assert.equal(icon.isEmpty(),false);
    const b=icon.toBitmap();let painted=0,transparent=0;
    for(let i=0;i<b.length;i+=4) {
      // Native bitmap channels are premultiplied by alpha on macOS.
      if(b[i+3]>230) { assert.ok([b[i],b[i+1],b[i+2]].every(v=>v<=2)); painted++; }
      if(!b[i+3])transparent++;
    }
    assert.ok(painted>5&&transparent>100);
    assert.equal(app.getName(),"呼噜呼噜");
    const quit=getRuntime().trayMenu.getMenuItemById("quit");
    assert.equal(quit.label,"退出呼噜呼噜");assert.equal(quit.icon,null);
    assert.equal(quit.role,null);
    assert.equal(getRuntime().tray.listenerCount("click"),0);
    assert.ok(getRuntime().tray.getBounds().width>0);
    assert.deepEqual(getRuntime().trayMenu.items.filter(item=>item.type==="radio").map(item=>item.id),["dodge","pet","beans"]);
    const petMode=getRuntime().trayMenu.getMenuItemById("pet");
    assert.match(petMode.label,/ⓘ$/);assert.equal(petMode.toolTip,"拖动换位置 · 长按抱抱 · 悬停摸头挠肚肚 · 方向键移动");
    assert.equal(await evaluate("document.querySelector('.pet').hasAttribute('title')"),false,"operation help no longer covers the pet as an HTML tooltip");
  });
  await check("shortcut submenu order, four registrations and no menu double-registration", ["shortcuts", "menu"], async () => {
    assert.ok(globalShortcut.isRegistered("Control+Alt+B"));
    assert.ok(globalShortcut.isRegistered("Control+Alt+Space"));
    assert.ok(globalShortcut.isRegistered("Control+Alt+Command+M"));
    assert.ok(globalShortcut.isRegistered("Control+Alt+Command+C"));
    const topLevel = getRuntime().trayMenu.items.map(item => item.id).filter(Boolean);
    assert.deepEqual(topLevel.slice(3, 7), ["characters", "appearance", "language", "shortcuts"]);
    assert.equal(getRuntime().trayMenu.getMenuItemById("hide").registerAccelerator,false);
    assert.equal(getRuntime().trayMenu.getMenuItemById("summon").registerAccelerator,false);
    assert.equal(getRuntime().trayMenu.getMenuItemById("cycle-mode").registerAccelerator,false);
    assert.equal(getRuntime().trayMenu.getMenuItemById("cycle-character").registerAccelerator,false);
    assert.equal(getRuntime().trayMenu.getMenuItemById("hide").accelerator, "Control+Alt+B");
    assert.equal(getRuntime().trayMenu.getMenuItemById("summon").accelerator, "Control+Alt+B");
  });
  await check("Character shortcut cycles once per press without revealing a hidden pet", ["shortcuts", "character"], async () => {
    if (!getRuntime().state.manualHidden) await toggleAndWait();
    const before = getRuntime().selectedCharacterId;
    await cycleCharacter();
    const next = getRuntime().selectedCharacterId;
    assert.notEqual(next, before);
    await cycleCharacter();
    assert.equal(getRuntime().selectedCharacterId, next, "holding the shortcut cannot skip characters");
    assert.equal(getRuntime().state.manualHidden, true);
    assert.equal(getRuntime().petWindow.isVisible(), false);
    await delay(420); await cycleCharacter();
    await delay(420); await cycleCharacter();
    assert.equal(getRuntime().selectedCharacterId, before);
    await toggleAndWait();
  });
  await check("Hide shortcut summons to the initial position on every redisplay", ["shortcuts", "hide"], async () => {
    setMode("pet"); summonPet(); await until(() => getRuntime().petWindow.isVisible());
    const initial = getRuntime().position;
    await evaluate(`window.bluepet.dragPet({phase:'start',point:{x:${initial.x + 66},y:${initial.y + 66}}});window.bluepet.dragPet({phase:'move',point:{x:${initial.x - 34},y:${initial.y - 14}}});window.bluepet.dragPet({phase:'end',point:{x:${initial.x - 34},y:${initial.y - 14}}})`);
    await until(() => Math.abs(getRuntime().position.x - initial.x) > 50);
    await toggleAndWait();
    assert.equal(getRuntime().state.manualHidden, true);
    toggleHidden(); await until(() => getRuntime().petWindow.isVisible());
    assert.deepEqual(getRuntime().position, initial);
  });
  await check("Mode shortcut: cycle order, repeat guard, chat exit and hidden-pet protection", ["shortcuts", "mode"], async()=>{
    setMode("dodge");cycleMode();assert.equal(getRuntime().state.mode,"pet");
    cycleMode();assert.equal(getRuntime().state.mode,"pet","holding the shortcut cannot race through modes");
    await delay(420);showChat();cycleMode();assert.equal(getRuntime().state.mode,"beans");
    assert.equal(getRuntime().state.chatOpen,false);await until(()=>getRuntime().gameWindow?.isVisible());
    await delay(420);cycleMode();assert.equal(getRuntime().state.mode,"dodge");
    assert.equal(getRuntime().gameWindow,undefined);
    await toggleAndWait();await delay(420);cycleMode();assert.equal(getRuntime().state.mode,"dodge");
    assert.equal(getRuntime().petWindow.isVisible(),false);await toggleAndWait();
  });
  await check("Frame clock: idle avoids native position writes and hidden frames stop", ["motion", "renderer"], async()=>{
    setMode("pet");await until(()=>!getRuntime().modeTransition,7000);await delay(100);
    const win=getRuntime().petWindow,real=win.setPosition;let writes=0;
    win.setPosition=function(...args){writes++;return real.apply(this,args);};
    try {
      await delay(200);assert.equal(writes,0,"stationary Pet does not move its native window every frame");
      setMode("dodge");await delay(100);await toggleAndWait();const hidden=getRuntime().position;
      writes=0;await delay(700);assert.equal(writes,0);assert.deepEqual(getRuntime().position,hidden);
      assert.equal(win.isVisible(),false);await toggleAndWait();await delay(100);assert.equal(win.isVisible(),true);
    } finally {win.setPosition=real;}
  });
  for(const mode of ["dodge","pet"]) {
    await check(mode + ": visible geometry, real character pixels, chat roundtrip and boss-key restore", ["smoke", "mode", "chat", "hide"], async()=>{
      setMode(mode); await delay(180);
      assert.equal(getRuntime().petWindow.isVisible(),true);
      await visiblePixels();
      await toggleAndWait(); assert.equal(getRuntime().petWindow.isVisible(),false);
      await toggleAndWait(); await delay(160); assert.equal(getRuntime().petWindow.isVisible(),true); await visiblePixels();
      showChat(); await delay(140); assert.equal(await evaluate("document.body.classList.contains('chat-open')"),true);
      restorePetFrame(); await delay(220); assert.deepEqual(await evaluate("[innerWidth,innerHeight]"),[132,132]);
      await visiblePixels();
      const rect = await evaluate("document.querySelector('.pet').getBoundingClientRect().toJSON()");
      assert.ok(rect.left >= 0 && rect.right <= 132 && rect.top >= 0 && rect.bottom <= 132);
    });
  }
  await check("opening/cancelling status menu leaves hidden state and chat untouched", ["menu", "hide", "chat"], async()=>{
    setMode("pet"); await toggleAndWait();
    const before=getRuntime().state;
    const menu=getRuntime().trayMenu;
    menu.emit("menu-will-show",{}); getRuntime().tray.emit("click",{});
    await delay(120); assert.deepEqual(getRuntime().state,before); assert.equal(getRuntime().petWindow.isVisible(),false);
    menu.emit("menu-will-close",{}); assert.deepEqual(getRuntime().state,before);
    menu.getMenuItemById("pet").click(); await delay(150); assert.equal(getRuntime().petWindow.isVisible(),true);
  });
  await check("real native context menu opens and closes without revealing the hidden pet", ["focus", "menu", "hide"], async()=>{
    setMode("pet"); await toggleAndWait();
    const {tray,trayMenu}=getRuntime(),before=getRuntime().state;
    let opened=false,closed=false;
    trayMenu.once("menu-will-show",()=>{opened=true;});
    trayMenu.once("menu-will-close",()=>{closed=true;});
    const close=setTimeout(()=>tray.closeContextMenu(),500);
    tray.popUpContextMenu();
    await until(()=>opened,2000);
    assert.equal(getRuntime().petWindow.isVisible(),false);assert.deepEqual(getRuntime().state,before);
    await until(()=>closed,2000);clearTimeout(close);
    assert.deepEqual(getRuntime().state,before);
  });
  await check("Chat editing: native select-all, undo and redo in Pet and Dodge", ["focus", "chat"], async () => {
    for (const mode of ["pet", "dodge"]) {
      setMode(mode);
      showChat();
      const win = getRuntime().petWindow;
      await until(() => win.isFocused());
      await delay(100);
      await evaluate("(()=>{const i=document.querySelector('#message');i.value='edit-check';i.focus();i.setSelectionRange(10,10);})()");
      const key = (keyCode, shift = false) => {
        const modifiers = shift ? ["meta", "shift"] : ["meta"];
        win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      };
      key("A");
      await until(() => evaluate("(()=>{const i=document.querySelector('#message');return i.selectionStart===0&&i.selectionEnd===10})()"));
      win.webContents.insertText("changed");
      await until(() => evaluate("document.querySelector('#message').value==='changed'"));
      key("Z");
      await until(() => evaluate("document.querySelector('#message').value==='edit-check'"));
      key("Z", true);
      await until(() => evaluate("document.querySelector('#message').value==='changed'"));
      restorePetFrame();
    }
  });
  await check("Pet keyboard: four directions, release, focus loss, chat isolation and legacy Control alias", ["smoke", "focus", "pet", "keyboard"], async()=>{
    setMode("control"); await delay(150); assert.equal(getRuntime().state.mode,"pet");
    for(const [key,axis,sign] of [["LEFT","x",-1],["UP","y",-1],["RIGHT","x",1],["DOWN","y",1]]) {
      const win=getRuntime().petWindow;
      let before;
      const events=[];
      const collect=(_event,input)=>events.push({type:input.type,key:input.key,code:input.code});
      win.webContents.on("before-input-event",collect);
      for (let attempt=0; attempt<3; attempt++) {
        await focusWindow(win); before=getRuntime().position;
        win.webContents.sendInputEvent({type:"keyDown",keyCode:key}); await delay(200);
        if (await evaluate("document.querySelector('.mascot-svg').dataset.gait==='run'")) break;
        win.webContents.sendInputEvent({type:"keyUp",keyCode:key});
      }
      const after=getRuntime().position;
      assert.ok((after[axis]-before[axis])*sign>10, key+" should move "+JSON.stringify({before,after,events,state:getRuntime().state,focused:win.isFocused(),menuOpen:getRuntime().menuOpen}));
      assert.equal(await evaluate("document.querySelector('.mascot-svg').dataset.gait"),"run",JSON.stringify({key,events,state:getRuntime().state,focused:win.isFocused(),menuOpen:getRuntime().menuOpen}));
      if (axis === "x") assert.equal(await evaluate("document.querySelector('.mascot-svg').dataset.facing"), sign < 0 ? "left" : "right");
      assert.equal(await evaluate("document.querySelector('.mascot-svg').dataset.cursorGaze"), "true", "Pet eye follows the cursor rather than movement direction");
      assert.equal(await evaluate("document.querySelectorAll('.foot,.feet,.torso,.rig').length"),0);
      const bodyAnimation = await evaluate("document.querySelector('path.body').getAnimations().map(a=>a.effect.getTiming().duration)");
      assert.deepEqual(bodyAnimation,[220]);
      const shapeBefore = await evaluate("getComputedStyle(document.querySelector('path.body')).d");
      await delay(65);
      assert.notEqual(await evaluate("getComputedStyle(document.querySelector('path.body')).d"),shapeBefore);
      await visiblePixels();
      await writeFile(path.resolve("work/pet-move-"+key.toLowerCase()+".png"),(await win.webContents.capturePage()).toPNG());
      app.focus({steal:true}); win.focus(); win.webContents.focus();
      win.webContents.sendInputEvent({type:"keyUp",keyCode:key});
      assert.ok(events.some(e=>e.type==="keyUp"), "key release reaches main process");
      win.webContents.removeListener("before-input-event",collect);
      await until(() => evaluate("document.querySelector('.mascot-svg').dataset.gait === 'idle'"), 1000);
    }
    const win=getRuntime().petWindow;
    win.webContents.sendInputEvent({type:"keyDown",keyCode:"LEFT"}); await delay(100); win.emit("blur");
    await delay(100); assert.equal(await evaluate("document.querySelector('.mascot-svg').dataset.gait"),"idle");
    const beforeEscape=getRuntime().position;
    win.webContents.sendInputEvent({type:"keyDown",keyCode:"ESCAPE"}); await delay(120);
    assert.equal(getRuntime().state.mode,"pet"); assert.deepEqual(getRuntime().position,beforeEscape);
    showChat(); await delay(150);
    const beforeChat=getRuntime().position;
    win.webContents.sendInputEvent({type:"keyDown",keyCode:"RIGHT"});await delay(150);
    assert.deepEqual(getRuntime().position,beforeChat);
    win.webContents.sendInputEvent({type:"keyUp",keyCode:"RIGHT"});restorePetFrame();
  });
  await check("Pet: proximity, linger, strokes and clicks have distinct bounded reactions", ["pet", "interaction"], async()=>{
    setMode("pet"); await delay(180);
    await evaluate("document.querySelector('.pet').dispatchEvent(new PointerEvent('pointerenter'))");
    await delay(1200); assert.equal(await evaluate("document.body.dataset.reaction"),"nuzzle");
    await evaluate("(()=>{const p=document.querySelector('.pet'),r=p.getBoundingClientRect();for(const x of [r.x+10,r.x+80,r.x+10])p.dispatchEvent(new PointerEvent('pointermove',{clientX:x,clientY:r.y+20}));})()");
    assert.equal(await evaluate("document.body.dataset.reaction"),"headpat");
    await delay(380);
    assert.equal(await evaluate("new DOMMatrix(getComputedStyle(document.querySelector('.lid')).transform).m42"),-20);
    await evaluate("(()=>{const p=document.querySelector('.pet'),r=p.getBoundingClientRect();for(const x of [r.x+10,r.x+80,r.x+10])p.dispatchEvent(new PointerEvent('pointermove',{clientX:x,clientY:r.y+20}));})()");
    assert.equal(await evaluate("document.querySelector('.lid').getAnimations().length"),0,"repeated strokes do not keep the eye drooping");
    await evaluate("document.querySelector('.pet').click()"); assert.equal(await evaluate("document.body.dataset.reaction"),"hop");
    await writeFile(path.resolve("work/pet-hop.png"),(await getRuntime().petWindow.webContents.capturePage()).toPNG());
    await evaluate("(()=>{const p=document.querySelector('.pet'),r=p.getBoundingClientRect();p.dispatchEvent(new MouseEvent('click',{clientX:r.x+r.width*.5,clientY:r.y+r.height*.2,detail:1}));})()"); assert.equal(await evaluate("document.body.dataset.reaction"),"shy");
    await delay(1800); assert.equal(await evaluate("document.body.dataset.reaction"),undefined);
  });
  await check("Pet hint renders short copy in a cartoon bubble", ["pet", "appearance"], async()=>{
    getRuntime().trayMenu.getMenuItemById("locale-en").click();
    await until(() => evaluate("document.documentElement.lang === 'en' && document.querySelector('.desktop-pet').getAttribute('aria-label').includes('desktop pet')"));
    setMode("dodge");setMode("pet");await delay(150);
    getRuntime().trayMenu.emit("menu-will-show",{});
    await evaluate("document.querySelector('.pet').click()");
    assert.equal(await evaluate("document.body.dataset.reaction"),"hop");
    await until(()=>getRuntime().hintWindow?.isVisible());
    assert.equal(getRuntime().hintMessage, "I’m right here!");
    const hintWin=getRuntime().hintWindow;
    await evaluate("window.bluepet.setPetHint('That head pat feels really nice')");
    await until(() => getRuntime().hintMessage === "That head pat feels really nice");
    const westernLayout = await hintWin.webContents.executeJavaScript(`(() => {
      const hint = document.querySelector('#pet-hint'), range = document.createRange(); range.selectNodeContents(hint);
      return { width: hint.getBoundingClientRect().width, lines: range.getClientRects().length, anchor: parseFloat(getComputedStyle(hint).left) };
    })()`);
    assert.equal(hintWin.getBounds().width, 220);
    assert.ok(westernLayout.width >= 150 && westernLayout.lines <= 2, JSON.stringify(westernLayout));
    assert.ok(Math.abs(westernLayout.anchor - (getRuntime().position.x + 66 - hintWin.getBounds().x)) <= 1, "wide bubble tail remains anchored to the pet");
    await writeFile(path.resolve("work/pet-western-bubble.png"),(await hintWin.webContents.capturePage()).toPNG());
    getRuntime().trayMenu.getMenuItemById("locale-ja").click();
    await until(() => evaluate("document.documentElement.lang === 'ja' && document.querySelector('.desktop-pet').getAttribute('aria-label').includes('デスクトップ')"));
    await until(() => getRuntime().hintMessage === "");
    await evaluate("(()=>{const p=document.querySelector('.pet'),r=p.getBoundingClientRect();p.dispatchEvent(new MouseEvent('click',{clientX:r.x+r.width*.5,clientY:r.y+r.height*.2,detail:1}));})()");
    await until(() => getRuntime().hintMessage === "ちょっと照れる…");
    getRuntime().trayMenu.getMenuItemById("locale-zh-CN").click();
    await until(() => evaluate("document.documentElement.lang === 'zh-CN'") && getRuntime().hintMessage === "");
    setMode("dodge");setMode("pet");await delay(150);
    await evaluate("document.querySelector('.pet').click()");
    await until(() => /[\u4e00-\u9fff]/.test(getRuntime().hintMessage));
    await until(() => evaluate("document.body.dataset.reaction === undefined"), 1200);
    const lingerStarted = performance.now(), lingeringMessage = getRuntime().hintMessage;
    assert.ok(lingeringMessage, "interaction copy remains after its motion ends");
    await until(() => getRuntime().hintMessage === "", 1600);
    assert.ok(performance.now() - lingerStarted >= 900, "interaction copy gets a readable post-motion hold");
    await evaluate("window.bluepet.setPetHint('嘿嘿！')"); await until(() => getRuntime().hintMessage === "嘿嘿！");
    const visibleHintStyle=await hintWin.webContents.executeJavaScript("(()=>{const h=document.querySelector('#pet-hint'),s=getComputedStyle(h),tail=getComputedStyle(h,'::before');return {text:h.textContent,width:h.getBoundingClientRect().width,background:s.backgroundColor,color:s.color,border:s.borderTopWidth,shadow:s.boxShadow,tail:tail.content};})()");
    assert.equal(visibleHintStyle.background,nativeTheme.shouldUseDarkColors ? "rgb(32, 41, 65)" : "rgb(255, 253, 244)");
    assert.equal(visibleHintStyle.color,nativeTheme.shouldUseDarkColors ? "rgb(243, 246, 255)" : "rgb(23, 35, 75)");assert.equal(visibleHintStyle.border,"2px");
    assert.notEqual(visibleHintStyle.shadow,"none");assert.notEqual(visibleHintStyle.tail,"none");
    const petBounds=getRuntime().petWindow.getBounds(),shortBounds=hintWin.getBounds();
    assert.equal(petBounds.y+39-(shortBounds.y+shortBounds.height-3),2,"bubble tip stays two pixels above the pet head");
    await evaluate("window.bluepet.setPetHint('叮叮叮，今天也亮起来！')");
    await until(()=>getRuntime().hintMessage==='叮叮叮，今天也亮起来！');await delay(80);
    const longHint=await hintWin.webContents.executeJavaScript(`(()=>{const h=document.querySelector('#pet-hint'),text=h.firstChild,rows=new Map();for(let i=0;i<text.length;i++){const range=document.createRange();range.setStart(text,i);range.setEnd(text,i+1);const top=Math.round(range.getBoundingClientRect().top);rows.set(top,(rows.get(top)||0)+1);}return {width:h.getBoundingClientRect().width,maxCharactersPerLine:Math.max(...rows.values()),lines:rows.size};})()`);
    const longBounds=hintWin.getBounds();
    assert.ok(longHint.width>visibleHintStyle.width,"long interaction copy expands the bubble");
    assert.ok(longHint.maxCharactersPerLine<=6,"interaction copy uses no more than six characters per line");
    assert.ok(longHint.lines>=2,"long interaction copy wraps instead of overflowing");
    assert.ok(longBounds.height>shortBounds.height,"long copy grows upward in its own native window");
    assert.equal(longBounds.y+longBounds.height,shortBounds.y+shortBounds.height,"copy length never moves the bubble tip down onto the pet");
    // Real Chromium wrapping (punctuation, mixed scripts and word boundaries)
    // must fit the native window, including existing 50-unit authored dialogue.
    let hintLocale = 'zh-CN';
    for (const [language, message] of [
      ['zh-CN','戳脑袋是不科学的行为，会影响CPU……啊不，大脑运转。'],
      ['zh-CN','哈！'.repeat(25)],
      ['zh-CN','English words also wrap inside a Chinese bubble.'],
      ['ja','ちょっと待って！CPU……じゃなくて、頭がくすぐったい！'],
      ['en','A wonderfully unexpected little head pat, thank you'.slice(0,50)],
    ]) {
      assert.ok(message.length <= 50);
      if (language !== hintLocale) {
        getRuntime().trayMenu.getMenuItemById('locale-'+language).click();
        await until(()=>getRuntime().hintMessage === '' && hintWin.webContents.executeJavaScript(`document.documentElement.lang===${JSON.stringify(language)}`));
        hintLocale = language;
      }
      await evaluate(`window.bluepet.setPetHint(${JSON.stringify(message)})`);
      try {
        await until(()=>hintWin.isVisible() && hintWin.webContents.executeJavaScript(`document.querySelector('#pet-hint').textContent===${JSON.stringify(message)}`));
      } catch (error) {
        error.message += JSON.stringify({language,message,active:getRuntime().hintMessage,visible:hintWin.isVisible(),layout:await hintWin.webContents.executeJavaScript(`({text:document.querySelector('#pet-hint').textContent,lang:document.documentElement.lang,width:innerWidth,height:innerHeight})`)});
        throw error;
      }
      await delay(320);
      const layout = await hintWin.webContents.executeJavaScript(`(()=>{
        const h=document.querySelector('#pet-hint'),range=document.createRange();range.selectNodeContents(h);
        return {height:innerHeight,top:h.getBoundingClientRect().top,rows:[...range.getClientRects()].map(r=>({top:r.top,bottom:r.bottom,left:r.left,right:r.right})),width:innerWidth};
      })()`);
      assert.ok(layout.top>=0,JSON.stringify({language,message,layout}));
      assert.ok(layout.rows.every(r=>r.top>=0&&r.bottom<=layout.height&&r.left>=0&&r.right<=layout.width),JSON.stringify(layout));
      const bounds=hintWin.getBounds();
      assert.equal(bounds.height,layout.height);
      assert.equal(bounds.y+bounds.height,shortBounds.y+shortBounds.height);
      if(language==='zh-CN'&&message.includes('CPU')) await writeFile(path.resolve('work/pet-mixed-text-bubble.png'),(await hintWin.webContents.capturePage()).toPNG());
    }
    getRuntime().trayMenu.getMenuItemById('locale-zh-CN').click();
    await delay(80);
    await writeFile(path.resolve("work/pet-cartoon-bubble.png"),(await hintWin.webContents.capturePage()).toPNG());
    await evaluate("window.bluepet.setPetHint('')");await until(()=>!hintWin.isVisible());
    getRuntime().trayMenu.emit("menu-will-close",{});
  });
  await check("Pet idle variety maps to distinct gentle motions", ["pet", "motion"], async()=>{
    setMode("pet");await delay(100);
    for(const [kind,name] of [["idle-bob","idle-bob"],["idle-sway","idle-sway"]]) {
      const animations=await evaluate(`(()=>{const svg=document.querySelector('.mascot-svg');svg.dataset.reaction=${JSON.stringify(kind)};return document.querySelector('.mascot').getAnimations().map(animation=>animation.animationName);})()`);
      assert.ok(animations.includes(name),`${kind} should start ${name}`);
    }
    await evaluate("delete document.querySelector('.mascot-svg').dataset.reaction");
  });
  await check("Pet touch: tickle belly, poke, cheek nuzzle and native long-press cuddle", ["focus", "pet", "interaction"], async()=>{
    setMode("dodge"); setMode("pet"); await delay(150);
    getRuntime().trayMenu.emit("menu-will-show",{});
    const poke=(x,y)=>evaluate(`(()=>{const p=document.querySelector('.pet'),r=p.getBoundingClientRect();p.dispatchEvent(new MouseEvent('click',{clientX:r.x+r.width*${x},clientY:r.y+r.height*${y},detail:1}));})()`);
    await poke(.5,.75); assert.equal(await evaluate("document.body.dataset.reaction"),"poke");
    assert.match(await evaluate("document.querySelector('#pet-hint').textContent"),/肚肚/);
    await poke(.2,.5); assert.equal(await evaluate("document.body.dataset.reaction"),"nuzzle");
    await evaluate("document.querySelector('.pet').dispatchEvent(new PointerEvent('pointerleave'))");
    for(const x of [.3,.7,.3,.7]) {
      await evaluate(`(()=>{const p=document.querySelector('.pet'),r=p.getBoundingClientRect();p.dispatchEvent(new PointerEvent('pointermove',{clientX:r.x+r.width*${x},clientY:r.y+r.height*.75}));})()`);
      await delay(45);
    }
    assert.equal(await evaluate("document.body.dataset.reaction"),"tickle");
    assert.match(await evaluate("document.querySelector('#pet-hint').textContent"),/痒/);
    await writeFile(path.resolve("work/pet-tickle.png"),(await getRuntime().petWindow.webContents.capturePage()).toPNG());
    await delay(850); assert.equal(await evaluate("document.body.dataset.reaction"),undefined);
    getRuntime().trayMenu.emit("menu-will-close",{});
    const win=getRuntime().petWindow;
    app.focus({steal:true});win.focus();win.webContents.focus();await delay(120);
    const rect=await evaluate("document.querySelector('.pet').getBoundingClientRect().toJSON()");
    const bounds=win.getBounds();
    const point={x:Math.round(rect.x+rect.width*.5),y:Math.round(rect.y+rect.height*.75)};
    // Match the real screen position as the drag tests do. Missing global
    // coordinates reports (0,0) and can move native focus off the pet on macOS.
    point.globalX=bounds.x+point.x;point.globalY=bounds.y+point.y;
    await evaluate("window.pointerTrace=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture','blur'])window.addEventListener(type,e=>window.pointerTrace.push({type,buttons:e.buttons,x:e.screenX,y:e.screenY}),true)");
    win.webContents.sendInputEvent({type:"mouseMove",...point});
    win.webContents.sendInputEvent({type:"mouseDown",button:"left",clickCount:1,...point});
    await delay(720); assert.equal(await evaluate("document.body.dataset.reaction"),"cuddle",JSON.stringify({pending:getRuntime().dragPending,trace:await evaluate("window.pointerTrace")}));
    win.webContents.sendInputEvent({type:"mouseUp",button:"left",clickCount:1,...point});
    await delay(80); assert.equal(await evaluate("document.body.dataset.reaction"),"cuddle","release does not turn a cuddle into a poke");
    await writeFile(path.resolve("work/pet-cuddle.png"),(await win.webContents.capturePage()).toPNG());
    showChat();await delay(100);assert.equal(await evaluate("document.body.dataset.reaction"),undefined);
    restorePetFrame();getRuntime().trayMenu.emit("menu-will-close",{});
  });
  await check("Pet drag: native pointer capture, threshold, release without click and stable placement", ["focus", "pet", "drag"], async()=>{
    setMode("dodge");setMode("pet");await delay(200);
    const win=getRuntime().petWindow;
    await focusWindow(win);
    const rect=await evaluate("document.querySelector('.pet').getBoundingClientRect().toJSON()");
    const bounds=win.getBounds(), origin=getRuntime().position;
    const start={x:bounds.x+Math.round(rect.x+rect.width*.5),y:bounds.y+Math.round(rect.y+rect.height*.75)};
    const at=(type,point,extra={})=>{
      const b=win.getBounds();
      win.webContents.sendInputEvent({type,x:Math.round(point.x-b.x),y:Math.round(point.y-b.y),globalX:Math.round(point.x),globalY:Math.round(point.y),...extra});
    };
    at("mouseMove",start);at("mouseDown",start,{button:"left",clickCount:1});
    await until(()=>getRuntime().dragPending);
    at("mouseMove",{x:start.x+2,y:start.y+1},{modifiers:["leftButtonDown"]});await delay(80);
    assert.equal(getRuntime().dragPending,true,JSON.stringify(await evaluate("window.pointerTrace")));
    assert.deepEqual(getRuntime().position,origin,"tiny jitter does not move the window");
    const first={x:start.x-14,y:start.y-12};
    at("mouseMove",first,{modifiers:["leftButtonDown"]});
    await delay(120);
    assert.ok(getRuntime().position.x<origin.x-5,JSON.stringify({origin,position:getRuntime().position,pending:getRuntime().dragPending,trace:await evaluate("window.pointerTrace")}));
    assert.equal(await evaluate("document.body.classList.contains('is-dragging')"),true);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.pet')).cursor"),"grabbing");
    const target={x:start.x-90,y:start.y-60};
    at("mouseMove",target,{modifiers:["leftButtonDown"]});await delay(100);
    assert.ok(Math.abs(getRuntime().position.x-(origin.x-90))<2);
    assert.ok(Math.abs(getRuntime().position.y-(origin.y-60))<2);
    assert.equal(await evaluate("document.body.dataset.reaction"),undefined);
    await writeFile(path.resolve("work/pet-drag.png"),(await win.webContents.capturePage()).toPNG());
    at("mouseUp",target,{button:"left",clickCount:1});await until(()=>!getRuntime().dragPending);
    const dropped=getRuntime().position;await delay(300);
    assert.deepEqual(getRuntime().position,dropped);
    assert.equal(await evaluate("document.body.classList.contains('is-dragging')"),false);
    assert.equal(await evaluate("document.body.dataset.reaction"),undefined,"dropping does not poke, cuddle or tickle");
    at("mouseDown",target,{button:"left",clickCount:1});await delay(50);
    at("mouseUp",target,{button:"left",clickCount:1});await delay(100);
    assert.equal(await evaluate("document.body.dataset.reaction"),"poke","a fresh click still works after dragging");
  });
  await check("Pet drag: screen clamping, invalid coordinates, Escape/chat/hide/mode cancellation", ["focus", "pet", "drag"], async()=>{
    setMode("pet");await delay(150);
    const send=request=>evaluate("window.bluepet.dragPet("+JSON.stringify(request)+")");
    const origin=getRuntime().position;
    await send({phase:"start",point:origin});await until(()=>getRuntime().dragPending);
    await evaluate("window.bluepet.dragPet({phase:'move',point:{x:NaN,y:0}})");await delay(80);
    assert.deepEqual(getRuntime().position,origin);
    const cursor={x:-9000,y:-9000};await send({phase:"move",point:cursor});await delay(80);
    const display=screen.getDisplayNearestPoint(cursor).workArea,b=getRuntime().petWindow.getBounds();
    assert.ok(b.x>=display.x&&b.y>=display.y&&b.x+b.width<=display.x+display.width&&b.y+b.height<=display.y+display.height);
    getRuntime().petWindow.webContents.sendInputEvent({type:"keyDown",keyCode:"ESCAPE"});await delay(100);
    assert.equal(getRuntime().dragPending,false);
    await send({phase:"start",point:getRuntime().position});await until(()=>getRuntime().dragPending);
    showChat();await delay(100);assert.equal(getRuntime().dragPending,false);
    const inChat=getRuntime().position;
    await send({phase:"start",point:inChat});await send({phase:"move",point:{x:0,y:0}});await delay(100);
    assert.equal(getRuntime().dragPending,false);assert.deepEqual(getRuntime().position,inChat);
    restorePetFrame();await delay(100);
    await send({phase:"start",point:inChat});await until(()=>getRuntime().dragPending);
    await toggleAndWait();assert.equal(getRuntime().dragPending,false);await toggleAndWait();await delay(100);
    await send({phase:"start",point:getRuntime().position});await until(()=>getRuntime().dragPending);
    setMode("dodge");assert.equal(getRuntime().dragPending,false);setMode("pet");
  });
  await check("Pet makes a sparse autonomous gesture, rests, and yields to interaction/chat/hide", ["soak", "pet", "motion"], async()=>{
    setMode("dodge"); setMode("pet"); await delay(150);
    // Keep the real mouse position from perturbing this unattended-idle check.
    getRuntime().trayMenu.emit("menu-will-show",{});
    getRuntime().petWindow.webContents.send("pet:proximity",{near:false,x:0,y:0});
    await evaluate("document.querySelector('.pet').dispatchEvent(new PointerEvent('pointerleave'))");
    const start=performance.now();
    await until(()=>evaluate("Boolean(document.body.dataset.reaction?.startsWith('idle-'))"),16000);
    assert.ok(performance.now()-start>=7500,"autonomous motion keeps a quiet gap");
    assert.equal(await evaluate("document.body.dataset.reaction"),"idle-look");
    assert.ok(await evaluate("document.querySelector('#pet-hint').textContent.length>0"),"idle gesture carries a short utterance");
    await until(()=>getRuntime().hintWindow?.isVisible());
    assert.equal(await getRuntime().hintWindow.webContents.executeJavaScript("getComputedStyle(document.querySelector('#pet-hint')).backgroundColor"),nativeTheme.shouldUseDarkColors ? "rgb(32, 41, 65)" : "rgb(255, 253, 244)");
    await writeFile(path.resolve("work/pet-idle-look.png"),(await getRuntime().petWindow.webContents.capturePage()).toPNG());
    await until(()=>evaluate("document.body.dataset.reaction===undefined"),2000);
    assert.ok(await evaluate("document.querySelector('#pet-hint').textContent.length>0"),"idle bubble lingers after the gesture rests");
    await until(()=>evaluate("document.querySelector('#pet-hint').textContent===''"),1200);
    await delay(2500); assert.equal(await evaluate("document.body.dataset.reaction"),undefined);
    await until(()=>evaluate("document.body.dataset.reaction==='idle-stretch'"),17000);
    assert.ok((await evaluate("document.querySelector('.mascot').getAnimations().map(a=>a.animationName)")).includes("idle-stretch"));
    await evaluate("document.querySelector('.pet').dispatchEvent(new PointerEvent('pointerenter'))");
    assert.notEqual(await evaluate("document.body.dataset.reaction"),"idle-stretch");
    showChat(); await delay(1200); assert.equal(await evaluate("document.body.dataset.reaction"),undefined);
    await toggleAndWait(); await delay(100);
    assert.equal(await evaluate("document.querySelector('.lid').getAnimations().length"),0);
    assert.equal(await evaluate("new DOMMatrix(getComputedStyle(document.querySelector('.lid')).transform).m42"),-20);
    await toggleAndWait(); restorePetFrame(); getRuntime().trayMenu.emit("menu-will-close",{});
  });
  await check("Pet gaze rests after five still seconds and wakes on cursor movement", ["soak", "pet", "gaze"], async()=>{
    const realCursor=screen.getCursorScreenPoint;
    let cursor={x:getRuntime().position.x+240,y:getRuntime().position.y+66};
    screen.getCursorScreenPoint=()=>({...cursor});
    try {
      setMode("dodge");setMode("pet");await delay(150);
      await until(()=>evaluate("document.querySelector('.mascot-svg').dataset.cursorGaze==='true'"));
      await delay(5050);
      await until(()=>evaluate("document.querySelector('.mascot-svg').dataset.cursorGaze===undefined"),500);
      assert.equal(await evaluate("document.querySelector('.mascot-svg').dataset.looking"),undefined);
      cursor.x+=1;
      await until(()=>evaluate("document.querySelector('.mascot-svg').dataset.cursorGaze==='true'"),500);
    } finally {
      screen.getCursorScreenPoint=realCursor;
    }
  });
  await check("reduced-motion mode keeps eyes open and disables decorative motion", ["motion", "gaze"], async()=>{
    const win=getRuntime().petWindow;
    win.webContents.debugger.attach("1.3");
    try {
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
      await delay(100);
      await evaluate("document.querySelector('.pet').click()"); await delay(100);
      assert.equal(await evaluate("document.querySelector('.lid').getAnimations().length"),0);
      assert.equal(await evaluate("new DOMMatrix(getComputedStyle(document.querySelector('.lid')).transform).m42"),-20);
      assert.equal(await evaluate("document.querySelector('.mascot').getAnimations().length"),0);
    } finally {
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia",{features:[]});
      win.webContents.debugger.detach();
    }
  });
  await check("Pet avoidance: no wandering, fast reflex, and hover interaction priority", ["pet", "dodge", "interaction"], async()=>{
    setMode("dodge"); setMode("pet"); await until(()=>!getRuntime().modeTransition);
    const initial=getRuntime().position,area=screen.getDisplayNearestPoint(initial).workArea;
    const centered={x:area.x+area.width/2-66,y:area.y+area.height/2-66};
    for(const request of [{phase:"start",point:initial},{phase:"move",point:centered},{phase:"end"}]) {
      await evaluate("window.bluepet.dragPet("+JSON.stringify(request)+")");await delay(50);
    }
    const realCursor=screen.getCursorScreenPoint, realAnimations=systemPreferences.getAnimationSettings;
    const start={...getRuntime().position}, center={x:start.x+66,y:start.y+66};
    let cursor={x:center.x+260,y:center.y}, samples=0;
    screen.getCursorScreenPoint=()=>{samples++;return {...cursor};};
    systemPreferences.getAnimationSettings=()=>({...realAnimations.call(systemPreferences),prefersReducedMotion:false});
    try {
      await evaluate("window.bluepet.setPetHover(false)");
      await until(()=>samples>=3);
      await delay(250);
      assert.ok(Math.hypot(getRuntime().position.x-start.x,getRuntime().position.y-start.y)<2,"Pet 不应自主散步");
      cursor={x:center.x+105,y:center.y};
      await until(()=>getRuntime().dodgeMotion?.reflex);
      assert.ok(getRuntime().velocity.x<0,"快速逼近时 Pet 应向反方向闪避");
      await until(()=>evaluate("document.querySelector('.mascot-svg').dataset.gait==='run'"));
      await evaluate("window.bluepet.setPetHover(true)");
      await until(()=>getRuntime().petHovered&&Math.hypot(getRuntime().velocity.x,getRuntime().velocity.y)===0);
      const held={...getRuntime().position}; await delay(160);
      assert.ok(Math.hypot(getRuntime().position.x-held.x,getRuntime().position.y-held.y)<2,"进入互动区域后应停下，允许摸头和拖拽");
    } finally {
      screen.getCursorScreenPoint=realCursor; systemPreferences.getAnimationSettings=realAnimations;
      await evaluate("window.bluepet.setPetHover(false)");
    }
  });
  await check("Pet returns to its pre-dodge position three seconds after avoidance stops", ["soak", "pet", "dodge"], async()=>{
    setMode("dodge");setMode("pet");await until(()=>!getRuntime().modeTransition,7000);
    const initial=getRuntime().position,area=screen.getDisplayNearestPoint(initial).workArea;
    const realPoint=screen.getCursorScreenPoint();
    const safeHomes=[
      {x:area.x+area.width/2-66,y:area.y+180},
      {x:area.x+area.width/2-66,y:area.y+area.height-132-180},
    ];
    const safeHome=safeHomes.sort((a,b)=>
      Math.hypot(realPoint.x-b.x-66,realPoint.y-b.y-66)-Math.hypot(realPoint.x-a.x-66,realPoint.y-a.y-66))[0];
    for(const request of [{phase:"start",point:initial},{phase:"move",point:safeHome},{phase:"end"}]) {
      await evaluate("window.bluepet.dragPet("+JSON.stringify(request)+")");await delay(50);
    }
    const realCursor=screen.getCursorScreenPoint,realAnimations=systemPreferences.getAnimationSettings;
    const origin={...getRuntime().position},center={x:origin.x+66,y:origin.y+66};
    let cursor={x:center.x+240,y:center.y},samples=0,drifting=false,drift=0;
    screen.getCursorScreenPoint=()=>{
      samples++;
      if(drifting) drift=(drift+1)%20;
      return {x:cursor.x+drift,y:cursor.y};
    };
    systemPreferences.getAnimationSettings=()=>({...realAnimations.call(systemPreferences),prefersReducedMotion:false});
    try {
      await evaluate("window.bluepet.setPetHover(false)");await until(()=>samples>=3);
      cursor={x:center.x+105,y:center.y};
      await until(()=>getRuntime().dodgeMotion?.reflex);
      await until(()=>Math.hypot(getRuntime().position.x-origin.x,getRuntime().position.y-origin.y)>35);
      assert.deepEqual(getRuntime().petReturn.origin,origin,"return origin is captured before automatic avoidance moves the pet");
      await evaluate("window.bluepet.setPetHover(true)");
      await until(()=>getRuntime().petHovered&&Math.hypot(getRuntime().velocity.x,getRuntime().velocity.y)===0);
      assert.deepEqual(getRuntime().petHome,origin,"hovering after a dodge does not overwrite the stable Pet home");
      await evaluate("window.bluepet.setPetHover(false)");
      const displacedCenter={x:getRuntime().position.x+66,y:getRuntime().position.y+66};
      cursor={x:displacedCenter.x+240,y:displacedCenter.y};
      const samplesBeforeSecondDodge=samples;await until(()=>samples-samplesBeforeSecondDodge>=3);
      cursor={x:displacedCenter.x+105,y:displacedCenter.y};
      await until(()=>getRuntime().dodgeMotion?.reflex&&getRuntime().petReturn.active);
      assert.deepEqual(getRuntime().petReturn.origin,origin,"repeated dodges keep the same user-defined home");
      cursor={x:center.x+360,y:center.y};
      try {
        await until(()=>getRuntime().petReturn.active&&!getRuntime().petReturn.avoiding,6000);
      } catch {
        const snapshot=getRuntime();
        throw new Error("avoidance did not stop: "+JSON.stringify({
          petReturn:snapshot.petReturn,dodgeVelocity:snapshot.dodgeMotion?.velocity,
          position:snapshot.position,cursor,
        }));
      }
      const samplesAtRest=samples;drifting=true;
      await delay(2700);
      assert.notEqual(getRuntime().modeTransition?.kind,"pet-dodge-return","return does not start before avoidance has rested for three seconds");
      assert.ok(samples-samplesAtRest>20,"the test cursor keeps moving at a safe distance during the rest period");
      try {
        await until(()=>getRuntime().modeTransition?.kind==="pet-dodge-return",1500);
      } catch {
        const snapshot=getRuntime();
        throw new Error("return did not start: "+JSON.stringify({
          petReturn:snapshot.petReturn,petHovered:snapshot.petHovered,
          position:snapshot.position,origin,cursor,
        }));
      }
      await until(()=>!getRuntime().petReturn.active,3000);
      const settled=getRuntime().position;
      assert.ok(Math.hypot(settled.x-origin.x,settled.y-origin.y)<1,
        "Pet settles at its exact pre-dodge position: "+JSON.stringify({origin,settled}));
    } finally {
      screen.getCursorScreenPoint=realCursor;systemPreferences.getAnimationSettings=realAnimations;
      await evaluate("window.bluepet.setPetHover(false)");
    }
  });
  await check("Dodge reflex: fast approach launches a visible native window, decays and resets after chat/hide", ["dodge", "motion"], async()=>{
    setMode("pet");await delay(150);
    const origin=getRuntime().position,area=screen.getDisplayNearestPoint(origin).workArea;
    const target={x:area.x+area.width/2-66,y:area.y+area.height/2-66};
    for(const request of [{phase:"start",point:origin},{phase:"move",point:target},{phase:"end"}]) {
      await evaluate("window.bluepet.dragPet("+JSON.stringify(request)+")");await delay(50);
    }
    setMode("dodge");await until(()=>!getRuntime().modeTransition);
    const realCursor=screen.getCursorScreenPoint,realAnimations=systemPreferences.getAnimationSettings;
    const center={x:getRuntime().position.x+66,y:getRuntime().position.y+66};
    let cursor={x:center.x+230,y:center.y},samples=0;
    screen.getCursorScreenPoint=()=>{samples++;return {...cursor};};
    systemPreferences.getAnimationSettings=()=>({...realAnimations.call(systemPreferences),prefersReducedMotion:false});
    try {
      await until(()=>samples>=2);
      const before=getRuntime().petWindow.getBounds();
      cursor={x:center.x+110,y:center.y};
      await until(()=>getRuntime().dodgeMotion?.reflex);
      const initialSpeed=Math.hypot(...Object.values(getRuntime().dodgeMotion.velocity));
      assert.ok(initialSpeed>600,"fast approaching cursor produces a launch");
      await until(()=>evaluate("document.querySelector('.mascot-svg').dataset.gait==='run'"));
      assert.deepEqual(await evaluate("document.querySelector('path.body').getAnimations().map(a=>a.effect.getTiming().duration)"),[220]);
      await delay(100);
      assert.ok(getRuntime().petWindow.getBounds().x<before.x-45,"native window visibly travels away");
      assert.deepEqual(await evaluate("(()=>{const s=document.querySelector('.mascot-svg');return [s.dataset.facing,parseFloat(s.style.getPropertyValue('--gaze-x'))<0]})()"), ["left", true],
        "left-facing artwork reverses its local pupil offset so the final eye still watches the cursor on the right");
      assert.equal(getRuntime().petWindow.isVisible(),true);await visiblePixels();
      await delay(700);
      assert.equal(getRuntime().dodgeMotion.reflex,false);
      assert.equal(await evaluate("document.querySelector('.mascot-svg').dataset.gait"),"walk");
      assert.ok(Math.hypot(...Object.values(getRuntime().dodgeMotion.velocity))<initialSpeed/2);
      for(const pause of ["chat","hide"]) {
        if(pause==="chat") showChat(); else await toggleAndWait();
        await delay(80);
        cursor={x:getRuntime().position.x+90,y:getRuntime().position.y+66};
        if(pause==="chat") restorePetFrame(); else await toggleAndWait();
        await delay(80);assert.equal(getRuntime().dodgeMotion.reflex,false,"resume discards stale cursor samples");
        assert.equal(getRuntime().petWindow.isVisible(),true);
      }
      console.log("Dodge launch speed:",Math.round(initialSpeed),"px/s");
    } finally {
      screen.getCursorScreenPoint=realCursor;systemPreferences.getAnimationSettings=realAnimations;
      setMode("dodge");
    }
  });
  await check("Dodge stays continuously visible for 10 seconds, and only manual hide conceals it", ["soak", "dodge", "recovery"], async()=>{
    setMode("dodge");
    const start=performance.now();
    while(performance.now()-start<10000) {
      await delay(40); assert.equal(getRuntime().petWindow.isVisible(),true);
    }
    const gait=await evaluate("document.querySelector('.mascot-svg').dataset.gait");
    assert.ok(["walk","run"].includes(gait));
    assert.deepEqual(await evaluate("document.querySelector('path.body').getAnimations().map(a=>a.effect.getTiming().duration)"),[gait==="run"?220:680]);
    await visiblePixels();
    await writeFile(path.resolve("work/dodge-original-shape.png"),(await getRuntime().petWindow.webContents.capturePage()).toPNG());
    await toggleAndWait(); await delay(3300); assert.equal(getRuntime().petWindow.isVisible(),false);
    await toggleAndWait(); assert.equal(getRuntime().petWindow.isVisible(),true);
  });
  await check("Dodge chat and native menu roundtrips keep the current visibility", ["focus", "dodge", "chat", "menu"], async()=>{
    showChat(); await delay(300); assert.equal(getRuntime().petWindow.isVisible(),true);
    restorePetFrame(); await delay(200);
    const menu=getRuntime().trayMenu, before=getRuntime().position;
    menu.emit("menu-will-show",{}); await delay(400);
    assert.equal(getRuntime().petWindow.isVisible(),true); assert.deepEqual(getRuntime().position,before);
    menu.emit("menu-will-close",{}); assert.equal(getRuntime().petWindow.isVisible(),true);
  });
  await check("recover unexpected hide, monitor changes, sleep wake, renderer reload and window close", ["recovery", "hide"], async()=>{
    setMode("pet"); await delay(100); getRuntime().petWindow.hide();
    await until(()=>getRuntime().petWindow.isVisible(),2200); await visiblePixels();
    getRuntime().petWindow.setBounds({x:-9000,y:-9000,width:132,height:132});
    screen.emit("display-removed",{},screen.getPrimaryDisplay()); await delay(150);
    const b=getRuntime().petWindow.getBounds(),d=screen.getDisplayMatching(b).workArea;
    assert.ok(b.x>=d.x&&b.y>=d.y&&b.x+b.width<=d.x+d.width&&b.y+b.height<=d.y+d.height);
    await toggleAndWait();powerMonitor.emit("resume");assert.equal(getRuntime().petWindow.isVisible(),false);await toggleAndWait();
    getRuntime().petWindow.reload(); await delay(500); await visiblePixels();
    const old=getRuntime().petWindow.id;getRuntime().petWindow.close();
    await until(()=>getRuntime().petWindow&&getRuntime().petWindow.id!==old&&!getRuntime().petWindow.webContents.isLoading());
    await delay(180);await visiblePixels();
  });
  await check("Recovery: Pet and Eat Beans watchdog respect hidden state without stealing focus", ["recovery", "hide", "beans"], async () => {
    for (const mode of ["pet", "beans"]) {
      setMode(mode);
      await until(() => (mode === "pet" ? getRuntime().petWindow : getRuntime().gameWindow)?.isVisible());
      const win = mode === "pet" ? getRuntime().petWindow : getRuntime().gameWindow;
      await until(() => !win.webContents.isLoading());
      await delay(150);
      getRuntime().trayMenu.getMenuItemById("api-settings").click();
      await until(() => getRuntime().settingsWindow?.isFocused());
      win.hide();
      await until(() => win.isVisible(), 2000);
      assert.equal(getRuntime().settingsWindow.isFocused(), true, "watchdog must not steal focus");
      assert.equal(win.isFocused(), false);
      await visiblePixels(win);
      getRuntime().settingsWindow.close();
      await toggleAndWait();
      await delay(1100);
      recoverWindows();
      assert.equal(win.isVisible(), false, "recovery cannot reveal a manual hide");
      const menu = getRuntime().trayMenu;
      menu.emit("menu-will-show");
      cycleMode();
      menu.emit("menu-will-close");
      assert.equal(getRuntime().state.mode, mode);
      assert.equal(win.isVisible(), false);
      toggleHidden();
      await until(() => win.isVisible());
    }
    setMode("pet");
  });
  await check("Eat Beans resize: real native shrink preserves progress and every bean remains collectable", ["focus", "beans", "recovery"], async () => {
    setMode("beans");
    await until(() => getRuntime().gameWindow?.isVisible());
    const win = getRuntime().gameWindow;
    const js = code => win.webContents.executeJavaScript(code);
    await until(() => js("Boolean(document.querySelector('.hide-particles'))"));
    const original = win.getBounds();
    await js("import('./game.js').then(({game})=>{game.level=3;game.score=42;game.pet.speed=280*1.3**2;Object.assign(game.pet,{vx:0,vy:0});game.pellets=[{x:innerWidth-60,y:innerHeight-60,radius:5,glow:0},{x:innerWidth-160,y:innerHeight-60,radius:5,glow:0}];})");
    win.setBounds({ ...original, width: 600, height: 400 });
    await until(() => js("import('./game.js').then(({game})=>innerWidth===600&&innerHeight===400&&game.viewport.width===600&&game.viewport.height===400)"));
    assert.deepEqual(win.getSize(), [600, 400]);
    assert.equal(await js("import('./game.js').then(({game})=>game.pellets.length===2&&game.pellets.every(p=>p.x>=36&&p.x<=564&&p.y>=140&&p.y<=356)&&game.score===42&&game.level===3&&game.pet.speed===280*1.3**2)"), true);
    // With both remaining beans on one row, real key input must clear the
    // reflowed round; moving the pet does not relocate or delete the beans.
    await js("import('./game.js').then(({game})=>{game.pet.x=Math.min(...game.pellets.map(p=>p.x))-60;game.pet.y=game.pellets[0].y;})");
    app.focus({ steal: true });
    win.focus();
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "RIGHT" });
    await until(() => js("import('./game.js').then(({game})=>game.level===4)"));
    assert.equal(await js("import('./game.js').then(({game})=>game.score)"), 44);
    assert.ok(await js("import('./game.js').then(({game})=>Math.abs(game.pet.speed-280*1.3**3)<1e-9)"));
    await js("import('./game.js').then(({game})=>{game.pet.vx=game.pet.vy=0;})");
    win.hide();
    await until(() => win.isVisible(), 2000);
    assert.deepEqual(win.getSize(), [600, 400], "watchdog does not resize a valid game");
    await toggleAndWait();
    win.setBounds(original);
    await delay(650);
    assert.equal(win.isVisible(), false, "resize while manually hidden must not reveal the game");
    toggleHidden();
    await until(() => win.isVisible());
    assert.equal(await js("import('./game.js').then(({game})=>game.level)"), 4);
    setMode("pet");
  });
  await check("Eat Beans: smaller lidless sprite, real bean clears accelerate each round, hide/restore and restart", ["smoke", "focus", "beans", "mode"], async()=>{
    setMode("beans");await until(()=>getRuntime().gameWindow?.isVisible());
    const win=getRuntime().gameWindow;await delay(150);
    const js=code=>win.webContents.executeJavaScript(code);
    await until(()=>js("Boolean(document.querySelector('.mascot-svg'))"));
    assert.equal(await js("document.querySelectorAll('.lid').length"),0,"Eat Beans has no eyelid node");
    assert.equal(await js("getComputedStyle(document.querySelector('#game-pet')).width"),"64px");
    const before=await js("document.querySelector('#game-pet').style.transform");
    const initialPet = await js("document.querySelector('#game-pet').getBoundingClientRect().toJSON()");
    await js(`window.dispatchEvent(new PointerEvent('pointermove',{clientX:${initialPet.x + initialPet.width / 2},clientY:${initialPet.y - 100}}))`);
    win.webContents.sendInputEvent({type:"keyDown",keyCode:"UP"});await delay(200);
    assert.notEqual(await js("document.querySelector('#game-pet').style.transform"),before);
    assert.equal(await js("document.querySelector('.mascot-svg').dataset.cursorGaze"), "true");
    assert.ok(parseFloat(await js("document.querySelector('.mascot-svg').style.getPropertyValue('--gaze-y')"))<0);
    win.webContents.sendInputEvent({type:"keyDown",keyCode:"LEFT"}); await delay(60);
    assert.equal(await js("document.querySelector('.mascot-svg').dataset.facing"), "left");
    const gamePet = await js("document.querySelector('#game-pet').getBoundingClientRect().toJSON()");
    await js(`window.dispatchEvent(new PointerEvent('pointermove',{clientX:${gamePet.right + 100},clientY:${gamePet.y + gamePet.height / 2}}))`);
    await until(() => js("document.querySelector('.mascot-svg').dataset.cursorGaze === 'true'"));
    assert.ok(parseFloat(await js("document.querySelector('.mascot-svg').style.getPropertyValue('--gaze-x')")) < 0, "左朝向时局部瞳孔偏移应补偿镜像，最终仍看向右侧光标");
    await visiblePixels(win);
    const sprite=await js("document.querySelector('#game-pet').getBoundingClientRect().toJSON()");
    await writeFile(path.resolve("work/beans-no-lid.png"),(await win.webContents.capturePage({x:Math.round(sprite.x),y:Math.round(sprite.y),width:64,height:64})).toPNG());
    // Deterministic two-bean round; real key input and animation frames must eat both.
    await js("import('./game.js').then(({game})=>{Object.assign(game.pet,{x:200,y:200,vx:0,vy:0});game.pellets=[{x:260,y:200,radius:5,glow:0},{x:340,y:200,radius:5,glow:0}];})");
    win.webContents.sendInputEvent({type:"keyDown",keyCode:"RIGHT"});
    await until(()=>js("document.querySelector('#round').textContent==='2'"));
    assert.deepEqual(await js("import('./game.js').then(({game})=>[game.pet.speed,game.pet.vx,game.pet.vy])"),[364,364,0]);
    assert.equal(await js("document.querySelector('#speed').textContent"),"1.30×");
    await js("import('./game.js').then(({game})=>{Object.assign(game.pet,{x:200,y:200,vx:0,vy:0});game.pellets=[{x:260,y:200,radius:5,glow:0},{x:340,y:200,radius:5,glow:0}];})");
    win.webContents.sendInputEvent({type:"keyDown",keyCode:"RIGHT"});
    await until(()=>js("document.querySelector('#round').textContent==='3'"));
    assert.deepEqual(await js("import('./game.js').then(({game})=>[game.pet.speed,game.pet.vx].map(v=>Math.round(v*100)/100))"),[473.2,473.2]);
    assert.equal(await js("document.querySelector('#speed').textContent"),"1.69×");
    const hud=await js("document.querySelector('.hud').getBoundingClientRect().toJSON()");
    const hint=await js("document.querySelector('#level-message').getBoundingClientRect().toJSON()");
    assert.ok(hint.top>=hud.top&&hint.bottom<=hud.bottom,"round announcement stays within the HUD");
    assert.ok(await js("import('./game.js').then(({game})=>game.pellets.every(p=>p.y-p.radius>96))"));
    await js("import('./game.js').then(({game})=>{Object.assign(game.pet,{y:140,vy:-1000,vx:0});})");
    await delay(60);
    assert.ok((await js("document.querySelector('#game-pet').getBoundingClientRect().top"))>hud.bottom);
    await writeFile(path.resolve("work/beans-round-3.png"),(await win.webContents.capturePage()).toPNG());
    await toggleAndWait();assert.equal(win.isVisible(),false);await toggleAndWait();assert.equal(win.isVisible(),true);
    assert.equal(await js("document.querySelectorAll('.lid').length"),0);
    assert.equal(await js("document.querySelector('#round').textContent"),"3");
    win.webContents.sendInputEvent({type:"keyDown",keyCode:"ESCAPE"});await delay(180);assert.equal(getRuntime().state.mode,"pet");await visiblePixels();
    setMode("beans");await until(()=>getRuntime().gameWindow?.isVisible());await delay(200);
    assert.equal(await getRuntime().gameWindow.webContents.executeJavaScript("document.querySelector('#speed').textContent"),"1.00×");
    setMode("pet");
  });
  if(process.env.BLUEPET_TEST_CHAT==="1") await check("Chat live: Flash reply reaches the bubble with a 50-character cap", ["release", "chat", "live"], async()=>{
    setMode("pet");showChat();await delay(150);
    const started=performance.now();
    await evaluate("document.querySelector('#message').value='跟我打个招呼吧';document.querySelector('#chat-form').requestSubmit()");
    await until(()=>evaluate("!document.body.classList.contains('is-thinking')"),18000);
    assert.equal(await evaluate("document.querySelector('.speech__status').textContent"),"只告诉你");
    const reply=await evaluate("document.querySelector('#reply').textContent");
    assert.ok([...reply].length>0&&[...reply].length<=50);
    console.log("Live bubble reply:",JSON.stringify({elapsedMs:Math.round(performance.now()-started),reply}));
    restorePetFrame();
  });
  assert.ok(results.length, "test filter must select at least one check");
  console.log("Desktop integration checks passed:",results.length);
  await writeResults("passed");
  shutdown();
} catch(error) { console.error(error); await writeResults("failed", error); shutdown(1); }
}
run().catch(error => { console.error(error); shutdown(1); });
