import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  screen,
  systemPreferences,
  safeStorage,
  Tray,
} from "electron";
import {
  CHAT_OFFSET,
  chatFrame,
  chatMotionBounds,
  cursorInSpeech,
  cursorInPetSprite,
  createCursorAttention,
  createPetReturnTracker,
  controlVelocity,
  editingAction,
  fitPet,
  MODES,
  petShouldShow,
  petShouldAvoid,
  normalizeMode,
  nextMode,
  PET_FRAME_SIZE,
  PET_SPRITE_SIZE,
  validDragPoint,
  dragPosition,
} from "./core.js";
import { BLUE_ONE_EYE, characterDefinition } from "./characters.js";
import { transitionState } from "./app-state.js";
import { createApiSettingsStore } from "./api-settings.js";
import { analyzeCharacterImage, generateCharacterFields } from "./character-analysis.js";
import { createCharacterLibrary } from "./character-library.js";
import { CharacterError } from "./character-errors.js";
import { loadChatProvider, PROVIDER_NOT_CONFIGURED } from "./chat-provider.js";
import { askClaude } from "./chat.js";
import { createReminderStore, createReminders } from "./reminders.js";
import { createDodgeMotion } from "./dodge.js";
import { arriveAt, launchVelocity } from "./mode-motion.js";
import { brand, t } from "./i18n.js";
import { createPreferencesStore, LOCALE_CHOICES, THEMES } from "./preferences.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const PET_SIZE = PET_FRAME_SIZE;
const PET_HEAD_TOP_OFFSET = 39;
const HINT_HEAD_GAP = 2;
const HINT_TAIL_INSET = 3;
const HINT_CJK_CHARACTERS_PER_LINE = 6;
const HINT_WESTERN_CHARACTERS_PER_LINE = 22;
const HINT_WESTERN_WIDTH = 220;
const HINT_LINE_HEIGHT = 14;
const HINT_CHROME_HEIGHT = 25;
app.setName("呼噜呼噜");
const HIDE_SHORTCUT = process.env.BLUEPET_HIDE_SHORTCUT || "Control+Alt+B";
const CHAT_SHORTCUT = process.env.BLUEPET_CHAT_SHORTCUT || "Control+Alt+Space";
const MODE_SHORTCUT = process.env.BLUEPET_MODE_SHORTCUT || "Control+Alt+Command+M";
const CHARACTER_SHORTCUT = process.env.BLUEPET_CHARACTER_SHORTCUT || "Control+Alt+Command+C";
const requestedMode = normalizeMode(
  process.argv.find((arg) => arg.startsWith("--mode="))?.split("=")[1],
);
const initialMode = Object.values(MODES).includes(requestedMode) ? requestedMode : MODES.DODGE;
const state = { mode: initialMode, manualHidden: false, chatOpen: false, controlActive: false };
let petWindow, hintWindow, gameWindow, settingsWindow, apiSettingsStore, preferencesStore, characterLibrary, tray, trayMenu, loop;
let locale = "zh-CN";
let selectedCharacter = BLUE_ONE_EYE;
let reminders, reminderTimer, reminderView = "chat", autoReminder = false, screenLocked = false, suspended = false;
let reminderRequest;
function sendReminderState() {
  if (reminders) send("reminder:state", { ...reminders.snapshot(), view: reminderView });
}
function presentReminder() {
  reminderView = "note";
  autoReminder = true;
  interruptInteraction();
  dispatch("chat");
  syncWindows();
  sendReminderState();
}
export function checkReminders() {
  if (!reminders || quitting || !petReady) return;
  sendReminderState();
  const surface = screenLocked || suspended ? "defer" : state.manualHidden || state.mode === MODES.BEANS ? "notification"
    : state.chatOpen || dragSession || keys.size || menuOpen || reminders.busy ? "defer" : "bubble";
  try {
    const delivery = reminders.delivery(surface);
    if (!delivery) return;
    if (delivery.type === "bubble") presentReminder();
    else if (Notification.isSupported()) {
      // Lock-screen banners deliberately contain no reminder content.
      const notification = new Notification({ title: brand(locale), body: t(locale, "noteNotice"), silent: true });
      notification.on("click", () => {
        if (reminders.snapshot().note?.id !== delivery.note.id) return;
        showChat(); reminderView = "note"; sendReminderState();
      });
      notification.show();
    }
  } catch { send("reminder:error", "noteStorageFailed"); }
}
// Main-process test injection only: never exposed by preload or an IPC channel.
export function setReminderRequestForTest(request) { reminderRequest = request; }
let petReady = false,
  gameReady = false,
  quitting = false,
  menuOpen = false;
let position = { x: 80, y: 160 },
  velocity = { x: 48, y: 25 };
let lastTick = performance.now(),
  lastProximity = 0,
  lastCycle = -Infinity,
  lastCharacterCycle = -Infinity;
let reducedMotion = false;
let nativePosition;
let dragSession;
let petHovered = false;
let hintReady = false,
  hintMessage = "";
let hintMeasurement;
const dodge = createDodgeMotion();
const cursorAttention = createCursorAttention();
const petReturn = createPetReturnTracker();
let dodgeMotion;
let modeTransition, petHome;
let hideAnimation,
  hideSerial = 0,
  ignoringMouse;
const keys = new Set();
const webPreferences = {
  preload: path.join(dirname, "preload.cjs"),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  backgroundThrottling: false,
};
const hintWebPreferences = {
  preload: path.join(dirname, "hint-preload.cjs"),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  backgroundThrottling: false,
};

function characterServices() {
  if (process.env.BLUEPET_TEST_CHARACTER_ANALYSIS === "1") {
    const services = globalThis[Symbol.for("bluepet.characterTestServices")];
    if (typeof services?.provider !== "function" || typeof services?.request !== "function") throw new Error("Character test transport is required");
    return { provider: services.provider, request: services.request, locale };
  }
  return {
    provider: async () => {
      try { return apiSettingsStore.provider() || await loadChatProvider(); }
      catch (error) {
        if (error?.code === PROVIDER_NOT_CONFIGURED) throw error;
        throw new CharacterError("CHAR_PROVIDER_SETTINGS", "无法读取已保存的 API 设置。请清除后重新配置。");
      }
    },
    locale,
  };
}

const windowBackground = () => nativeTheme.shouldUseDarkColors ? "#11182b" : "#fbfcff";
function preferences() { return preferencesStore?.get() || { version: 1, theme: "system", locale: "system", resolvedLocale: locale }; }
function rendererWindows() { return [petWindow, hintWindow, gameWindow, settingsWindow, characterLibrary?.window].filter(win => win && !win.isDestroyed()); }
function fromRenderer(event) { return rendererWindows().some(win => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame); }
function broadcastPreferences() {
  const value = preferences();
  for (const win of rendererWindows()) win.webContents.send("preferences:changed", value);
}
function updateNativeSurfaces() {
  for (const win of [settingsWindow, characterLibrary?.window]) if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground());
}
function applyPreferences(value, { broadcast = true } = {}) {
  nativeTheme.themeSource = value.theme;
  locale = value.resolvedLocale;
  if (characterLibrary) {
    const source = characterLibrary.source();
    selectedCharacter = characterDefinition(source.id, source.profile, source.analysis, undefined, locale);
  }
  updateNativeSurfaces();
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.setTitle(t(locale, "settingsTitle", { brand: brand(locale) }));
  if (characterLibrary?.window && !characterLibrary.window.isDestroyed()) characterLibrary.window.setTitle(t(locale, "libraryTitle", { brand: brand(locale) }));
  if (tray) rebuildTrayMenu();
  if (broadcast) {
    broadcastPreferences();
    for (const win of [petWindow, gameWindow]) if (win && !win.isDestroyed()) win.webContents.send("character:changed");
  }
}
function setPreference(change) {
  try {
    const value = preferencesStore.set(change);
    applyPreferences(value);
  } catch {
    if (Notification.isSupported()) new Notification({ title: brand(locale), body: t(locale, "operationFailed") }).show();
  }
}

ipcMain.handle("preferences:get", event => fromRenderer(event) ? { ok: true, value: preferences() } : { ok: false, error: "invalid-renderer" });

function dispatch(type, payload = {}) {
  Object.assign(state, transitionState(state, { type, ...payload }));
}

// The tray app has no application menu. Both input windows need native editing
// commands; handling them here also keeps clipboard access out of the bridge.
function bindEditingShortcuts(win) {
  win.webContents.on("before-input-event", (event, input) => {
    const action = editingAction(input, process.platform);
    if (!action) return;
    event.preventDefault();
    win.webContents[action]();
  });
}

function activeWindow() {
  return state.mode === MODES.BEANS ? gameWindow : petWindow;
}

function send(channel, payload) {
  if (petReady && petWindow && !petWindow.isDestroyed())
    petWindow.webContents.send(channel, payload);
}
function sendPetMotion(motion, cursor = screen.getCursorScreenPoint()) {
  if ([MODES.DODGE, MODES.PET].includes(state.mode) && selectedCharacter.gaze && petReady && petWindow && !petWindow.isDestroyed()) {
    const frame = petWindow.getBounds();
    const watching = state.mode !== MODES.PET || cursorAttention.sample(cursor, performance.now());
    // Selected character's gaze anchor, mapped into the actual native frame.
    // Gaze is independent of escape velocity, including when chat/menu freezes movement.
    motion = {
      ...motion,
      gaze: watching ? {
        x: cursor.x - (frame.x + (frame.width - PET_SPRITE_SIZE) / 2 + selectedCharacter.gaze.x * PET_SPRITE_SIZE),
        y:
          cursor.y - (frame.y + frame.height - 7 - PET_SPRITE_SIZE + selectedCharacter.gaze.y * PET_SPRITE_SIZE),
      } : null,
    };
  }
  send("pet:motion", motion);
}
function currentDisplay() {
  return screen.getDisplayNearestPoint({
    x: Math.round(position.x + PET_SIZE / 2),
    y: Math.round(position.y + PET_SIZE / 2),
  });
}
function cursorDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}
function pinPet(display = cursorDisplay()) {
  const b = display.workArea;
  position = fitPet(
    { x: b.x + b.width - PET_SIZE - 28, y: b.y + b.height - PET_SIZE - 24 },
    b,
    PET_SIZE,
  );
  petHome = { ...position };
}
function cancelModeTransition() {
  modeTransition = undefined;
  velocity = { x: 0, y: 0 };
}
function movePetWindow() {
  if (state.chatOpen) constrainPetPosition();
  const frame = state.chatOpen ? petFrame() : position;
  const x = Math.round(frame.x),
    y = Math.round(frame.y);
  if (nativePosition?.x === x && nativePosition?.y === y) return;
  petWindow.setPosition(x, y, false);
  nativePosition = { x, y };
  syncHint();
}

function hintHeight(message) {
  if (hintMeasurement?.message === message && hintMeasurement.locale === locale) return hintMeasurement.height;
  const charactersPerLine = ["zh-CN", "zh-TW", "ja"].includes(locale) ? HINT_CJK_CHARACTERS_PER_LINE : HINT_WESTERN_CHARACTERS_PER_LINE;
  const lines = Math.max(1, Math.ceil(Array.from(message).length / charactersPerLine));
  return lines * HINT_LINE_HEIGHT + HINT_CHROME_HEIGHT;
}
function hintLayout(message) {
  const height = hintHeight(message);
  const width = ["zh-CN", "zh-TW", "ja"].includes(locale) ? PET_SIZE : HINT_WESTERN_WIDTH;
  const workArea = currentDisplay().workArea;
  const petCenter = position.x + PET_SIZE / 2;
  const x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, petCenter - width / 2));
  const bounds = {
    x: Math.round(x),
    y: Math.round(position.y + PET_HEAD_TOP_OFFSET - HINT_HEAD_GAP - height + HINT_TAIL_INSET),
    width,
    height,
  };
  return { bounds, anchorX: Math.round(petCenter - bounds.x) };
}
function syncHint() {
  if (!hintReady || !hintWindow || hintWindow.isDestroyed()) return;
  const visible = Boolean(
    hintMessage &&
      state.mode === MODES.PET &&
      !state.chatOpen &&
      !state.manualHidden &&
      petWindow?.isVisible(),
  );
  if (!visible) {
    hintWindow.hide();
    return;
  }
  const layout = hintLayout(hintMessage);
  hintWindow.setBounds(layout.bounds, false);
  hintWindow.webContents.send("hint:message", { message: hintMessage, anchorX: layout.anchorX });
  // Do not expose a guessed, potentially clipped frame before Chromium lays out the text.
  if (hintMeasurement?.message !== hintMessage || hintMeasurement.locale !== locale) {
    hintWindow.hide();
    return;
  }
  raiseWindow(hintWindow);
  hintWindow.showInactive();
}
function setHintMessage(message) {
  if (typeof message !== "string" || message.length > 50 || /[\x00-\x1f\x7f]/.test(message)) return;
  hintMessage = message;
  if (message && (!hintWindow || hintWindow.isDestroyed())) createHintWindow();
  syncHint();
}
function stopControl() {
  keys.clear();
  dispatch("release-control");
  sendPetMotion({ x: 0, y: 0, gait: "idle" });
}
function endPetDrag() {
  if (!dragSession) return;
  dragSession = undefined;
  send("pet:drag-end");
}
function interruptInteraction({ preserveMotion = false } = {}) {
  endPetDrag();
  stopControl();
  dodge.reset();
  petReturn.cancel();
  if (!preserveMotion) cancelModeTransition();
}
function handlePetDrag(event, request) {
  if (!fromPet(event) || !request) return;
  if (request.phase === "end") {
    endPetDrag();
    return;
  }
  if (
    state.mode !== MODES.PET ||
    state.chatOpen ||
    state.manualHidden ||
    menuOpen ||
    !petWindow.isVisible()
  ) {
    endPetDrag();
    send("pet:drag-end");
    return;
  }
  if (!validDragPoint(request.point)) return;
  if (request.phase === "start") {
    interruptInteraction();
    dragSession = { origin: { ...position }, start: request.point };
  } else if (request.phase === "move" && dragSession) {
    const display = screen.getDisplayNearestPoint({
      x: Math.round(request.point.x),
      y: Math.round(request.point.y),
    });
    position = dragPosition(dragSession.origin, dragSession.start, request.point, display.workArea);
    petHome = { ...position };
    movePetWindow();
  }
}
function normalFrame() {
  const fitted = fitPet(position, currentDisplay().workArea, PET_SIZE);
  return { x: Math.round(fitted.x), y: Math.round(fitted.y), width: PET_SIZE, height: PET_SIZE };
}
function petFrame() {
  if (!state.chatOpen) return normalFrame();
  const chat = chatFrame(position, currentDisplay().workArea);
  return { ...chat, x: Math.round(chat.x), y: Math.round(chat.y) };
}
function constrainPetPosition() {
  position = fitPet(position, currentDisplay().workArea, PET_SIZE);
  if (state.chatOpen) {
    const frame = chatFrame(position, currentDisplay().workArea);
    // Commit the clamped physics anchor explicitly; frame queries are read-only.
    position = { x: frame.x + CHAT_OFFSET.x, y: frame.y + CHAT_OFFSET.y };
  }
}
function ignorePetMouse(ignore) {
  if (ignoringMouse === ignore) return;
  petWindow.setIgnoreMouseEvents(ignore, { forward: true });
  ignoringMouse = ignore;
}
function cancelHide() {
  if (!hideAnimation) return;
  clearTimeout(hideAnimation.timer);
  if (!hideAnimation.win.isDestroyed()) hideAnimation.win.webContents.send("pet:hide-cancel");
  hideAnimation = undefined;
}
function finishHide(id) {
  if (hideAnimation?.id !== id) return;
  const { win } = hideAnimation;
  clearTimeout(hideAnimation.timer);
  hideAnimation = undefined;
  if (state.manualHidden) {
    if (!win.isDestroyed()) win.hide();
    syncWindows();
  }
}
function animateHide(win) {
  cancelHide();
  const id = ++hideSerial;
  hideAnimation = { id, win, timer: setTimeout(() => finishHide(id), 460) };
  win.setIgnoreMouseEvents(true, { forward: true });
  if (win === petWindow) ignoringMouse = true;
  win.blur();
  win.webContents.send("pet:hide", {
    id,
    reducedMotion: systemPreferences.getAnimationSettings().prefersReducedMotion,
  });
}
function raiseWindow(win) {
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
}

// Both surfaces share the same visibility intent. Only explicit user actions
// request focus; watchdog recovery must not move or activate a healthy window.
function syncWindows({ focus = false, relocateGame = false } = {}) {
  if (quitting || (state.manualHidden && hideAnimation)) return;
  if (!state.manualHidden) cancelHide();
  syncPet({ focus });
  syncGame({ focus, relocateGame });
}

function syncPet({ focus = false } = {}) {
  if (!petReady || !petWindow || petWindow.isDestroyed()) return;
  raiseWindow(petWindow);
  const focusable = state.chatOpen || state.mode === MODES.PET;
  petWindow.setFocusable(focusable);
  constrainPetPosition();
  petWindow.setBounds(petFrame(), false);
  nativePosition = undefined;
  petWindow.setOpacity(1);
  ignorePetMouse(
    state.mode === MODES.DODGE &&
      (!state.chatOpen || !cursorInSpeech(screen.getCursorScreenPoint(), petWindow.getBounds())),
  );
  const visible = petShouldShow(state);
  send("pet:state", { ...state, visible, focusInput: focus && reminderView === "chat" });
  sendReminderState();
  if (visible) {
    send("pet:hide-cancel");
    if (petWindow.isMinimized()) petWindow.restore();
    petWindow.showInactive();
    if (focus && focusable) {
      app.focus({ steal: true });
      petWindow.show();
      petWindow.focus();
      dispatch("focus");
    }
  } else petWindow.hide();
  syncHint();
}
export function restorePetFrame() {
  const wasNote = reminderView !== "chat" || autoReminder;
  if (reminderView === "note") {
    try { reminders?.dismissDue(); } catch { send("reminder:error", "noteStorageFailed"); return; }
  }
  reminders?.dismiss();
  reminderView = "chat"; autoReminder = false;
  interruptInteraction();
  dispatch("dismiss-chat");
  syncWindows({ focus: !wasNote && state.mode === MODES.PET && !state.manualHidden });
}
export function showChat() {
  autoReminder = false;
  const note = reminders?.snapshot().note;
  reminderView = note?.due ? "note" : "chat";
  const wasHidden = state.manualHidden || !activeWindow()?.isVisible();
  interruptInteraction();
  if (state.mode === MODES.BEANS) setMode(MODES.PET);
  dispatch("chat");
  if (wasHidden) pinPet();
  syncWindows({ focus: true });
  rebuildTrayMenu();
}
export function toggleHidden() {
  interruptInteraction();
  // Unexpectedly hidden windows recover on the first press.
  const target = activeWindow();
  const currentlyVisible = !state.manualHidden && target?.isVisible();
  if (!currentlyVisible) {
    summonPet();
    return;
  }
  dispatch("hide");
  reminders?.resetPresentation();
  animateHide(target);
  rebuildTrayMenu();
}
export function summonPet() {
  interruptInteraction();
  dispatch("reveal");
  pinPet();
  recoverWindows({ focus: true });
  rebuildTrayMenu();
}
function closeGame() {
  if (!gameWindow) return;
  const win = gameWindow;
  gameWindow = undefined;
  gameReady = false;
  win.removeAllListeners("closed");
  win.close();
}
function syncGame({ focus = false, relocateGame = false } = {}) {
  if (state.mode !== MODES.BEANS) {
    closeGame();
    return;
  }
  if (!gameWindow || gameWindow.isDestroyed()) {
    if (!state.manualHidden) createGameWindow({ focus });
    return;
  }
  if (!gameReady) return;
  if (state.manualHidden) {
    if (!hideAnimation) gameWindow.hide();
    return;
  }
  raiseWindow(gameWindow);
  if (relocateGame) gameWindow.setBounds(cursorDisplay().bounds);
  gameWindow.setIgnoreMouseEvents(false);
  gameWindow.webContents.send("pet:hide-cancel");
  if (gameWindow.isMinimized()) gameWindow.restore();
  if (!gameWindow.isVisible()) gameWindow.showInactive();
  if (focus) {
    app.focus({ steal: true });
    gameWindow.show();
    gameWindow.focus();
  }
}
function createGameWindow({ focus = false } = {}) {
  gameReady = false;
  const win = new BrowserWindow({
    ...cursorDisplay().bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    title: t(locale, "gameTitle", { brand: brand(locale) }),
    webPreferences,
  });
  gameWindow = win;
  raiseWindow(win);
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault();
      setMode(MODES.PET);
    }
  });
  win.once("ready-to-show", () => {
    if (gameWindow === win) {
      gameReady = true;
      syncGame({ focus });
    }
  });
  win.on("closed", () => {
    if (gameWindow === win) {
      gameWindow = undefined;
      gameReady = false;
      if (!quitting) setMode(MODES.PET);
    }
  });
  win.webContents.on("render-process-gone", () => {
    if (!quitting && gameWindow === win) {
      closeGame();
      syncWindows();
    }
  });
  win.loadFile(path.join(dirname, "renderer/game.html"));
}
export function setMode(nextMode) {
  nextMode = normalizeMode(nextMode);
  if (!Object.values(MODES).includes(nextMode)) return;
  reminders?.resetPresentation();
  reminderView = "chat"; autoReminder = false;
  const wasHidden = state.manualHidden || !activeWindow()?.isVisible();
  cancelHide();
  const previousMode = state.mode;
  if (previousMode !== nextMode) cursorAttention.reset();
  const smooth =
    previousMode !== nextMode &&
    [previousMode, nextMode].every((mode) => mode === MODES.PET || mode === MODES.DODGE) &&
    !state.manualHidden &&
    !state.chatOpen &&
    petWindow?.isVisible();
  const momentum = { ...velocity };
  interruptInteraction({ preserveMotion: true });
  closeGame();
  dispatch("mode", { mode: nextMode });
  if (wasHidden) pinPet();
  modeTransition = undefined;
  if (smooth && !systemPreferences.getAnimationSettings().prefersReducedMotion) {
    velocity = momentum;
    modeTransition =
      nextMode === MODES.PET
        ? { target: fitPet(petHome || position, currentDisplay().workArea) }
        : { remaining: 0.8 };
  } else {
    velocity = { x: 0, y: 0 };
    if (nextMode === MODES.PET && previousMode !== MODES.PET)
      position = fitPet(petHome || position, currentDisplay().workArea);
    else position = fitPet(position, currentDisplay().workArea);
  }
  syncWindows({ focus: nextMode !== MODES.DODGE });
  rebuildTrayMenu();
}
export function cycleMode() {
  const now = performance.now();
  // A held key must not open/close the game repeatedly or reveal a hidden pet.
  if (state.manualHidden || now - lastCycle < 400) return;
  lastCycle = now;
  setMode(nextMode(state.mode));
}
export async function cycleCharacter() {
  const now = performance.now();
  if (now - lastCharacterCycle < 400) return;
  lastCharacterCycle = now;
  try {
    await characterLibrary?.cycle();
  } catch {
    if (Notification.isSupported()) new Notification({ title: brand(locale), body: t(locale, "characterOperationFailed") }).show();
  }
}
export function recoverWindows({ focus = false, relocateGame = true } = {}) {
  if (quitting) return;
  interruptInteraction();
  position = fitPet(position, currentDisplay().workArea, PET_SIZE);
  if (!petWindow || petWindow.isDestroyed()) createPetWindow();
  syncWindows({ focus, relocateGame });
}
function tick() {
  const now = performance.now(),
    elapsed = (now - lastTick) / 1000,
    dt = Math.min(0.06, elapsed);
  if (elapsed < 0.004) return; // Bound IPC bursts without imposing a 60Hz ceiling.
  lastTick = now;
  if (!petReady || dragSession || state.manualHidden || state.mode === MODES.BEANS) {
    dodge.reset();
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  let returnState = petReturn.state(now);
  if (
    modeTransition?.kind === "pet-dodge-return" &&
    Math.hypot(cursor.x - position.x - PET_SIZE / 2, cursor.y - position.y - PET_SIZE / 2) < 190
  ) {
    returnState = petReturn.sample(true, now);
    cancelModeTransition();
  }
  if (menuOpen) {
    dodge.reset();
    sendPetMotion({ x: 0, y: 0, gait: "idle" }, cursor);
    return;
  }
  if (state.chatOpen) {
    const overSpeech = cursorInSpeech(cursor, petWindow.getBounds());
    ignorePetMouse(state.mode === MODES.DODGE && !overSpeech);
    if (state.mode !== MODES.DODGE || overSpeech) {
      dodge.reset();
      velocity = { x: 0, y: 0 };
      dodgeMotion = undefined;
      sendPetMotion({ x: 0, y: 0, gait: "idle" }, cursor);
      return;
    }
  }
  const bounds = currentDisplay().workArea;
  const reduced = reducedMotion;
  if (reduced && modeTransition) cancelModeTransition();
  if (
    state.mode === MODES.PET && returnState.ready && !modeTransition && !keys.size && !petHovered
  ) {
    dodge.reset();
    dodgeMotion = undefined;
    const target = fitPet(returnState.origin, bounds);
    if (reduced) {
      position = target;
      velocity = { x: 0, y: 0 };
      petReturn.cancel();
      returnState = petReturn.state(now);
    } else modeTransition = { target, kind: "pet-dodge-return" };
  }
  let arrivedPosition;
  if (modeTransition?.target) {
    const transition = modeTransition;
    const motion = arriveAt(position, velocity, modeTransition.target, dt, bounds);
    arrivedPosition = motion.position;
    velocity = motion.velocity;
    if (motion.done) {
      modeTransition = undefined;
      if (transition.kind === "pet-dodge-return") petReturn.cancel();
    }
  } else if (state.mode === MODES.DODGE || petShouldAvoid({
    mode: state.mode, chatOpen: state.chatOpen, manualControl: keys.size > 0,
    hovered: petHovered || cursorInPetSprite(cursor, position),
  })) {
    dodgeMotion = dodge.step({
      petCenter: {
        x: position.x + PET_SIZE / 2,
        y: position.y + (state.chatOpen ? 83 : PET_SIZE / 2),
      },
      cursor,
      dt: elapsed,
      bounds: state.chatOpen ? chatMotionBounds(bounds) : bounds,
      reducedMotion: reduced,
      allowWander: state.mode === MODES.DODGE && !state.chatOpen,
    });
    const petAvoiding = state.mode === MODES.PET && Math.hypot(dodgeMotion.velocity.x, dodgeMotion.velocity.y) > .01;
    if (petAvoiding && !petReturn.active) {
      returnState = petReturn.begin(petHome || position, now);
    }
    if (state.mode === MODES.PET && petReturn.active) returnState = petReturn.sample(petAvoiding, now);
    velocity = modeTransition
      ? launchVelocity(velocity, dodgeMotion.velocity, dt)
      : dodgeMotion.velocity;
    if (modeTransition) {
      modeTransition.remaining -= dt;
      if (modeTransition.remaining <= 0) modeTransition = undefined;
    }
  } else {
    dodge.reset();
    dodgeMotion = undefined;
    velocity = keys.size ? controlVelocity(keys) : { x: 0, y: 0 };
    if (state.mode === MODES.PET && petReturn.active) returnState = petReturn.sample(false, now);
  }
  position =
    arrivedPosition ||
    fitPet({ x: position.x + velocity.x * dt, y: position.y + velocity.y * dt }, bounds, PET_SIZE);
  if (state.mode === MODES.PET && keys.size && !modeTransition) petHome = { ...position };
  movePetWindow();
  const moving = Math.hypot(velocity.x, velocity.y) > 0;
  sendPetMotion(
    { ...velocity, gait: moving ? (state.mode === MODES.PET && keys.size ? "run" : dodgeMotion?.gait || "run") : "idle" },
    cursor,
  );
  if (state.mode === MODES.PET && !moving && now - lastProximity >= 50) {
    lastProximity = now;
    const x = cursor.x - position.x - PET_SIZE / 2;
    const y = cursor.y - position.y - PET_SIZE + 7 + PET_SPRITE_SIZE / 2;
    send("pet:proximity", { near: Math.hypot(x, y) < 100, x, y });
  }
}
function controlInput(event, input) {
  if (state.mode !== MODES.PET || state.chatOpen || state.manualHidden) return;
  if (input.type === "keyDown" && input.key === "Escape") {
    event.preventDefault();
    interruptInteraction();
    petWindow.blur();
    return;
  }
  if (dragSession) return;
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(input.key)) return;
  // Let Chromium receive keydown: cancelling it here can suppress the matching
  // native keyup on macOS. The renderer suppresses only scrolling/default actions.
  if (input.type === "keyDown") {
    petReturn.cancel();
    cancelModeTransition();
    keys.add(input.key);
    dispatch("focus");
  }
  if (input.type === "keyUp") keys.delete(input.key);
}
function createPetWindow() {
  petReady = false;
  nativePosition = undefined;
  ignoringMouse = undefined;
  const win = new BrowserWindow({
    ...normalFrame(),
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: false,
    acceptFirstMouse: true,
    hasShadow: false,
    webPreferences,
  });
  petWindow = win;
  raiseWindow(win);
  bindEditingShortcuts(win);
  win.webContents.on("before-input-event", controlInput);
  win.on("blur", () => interruptInteraction({ preserveMotion: true }));
  win.webContents.on("did-start-loading", () => { petHovered = false; setHintMessage(""); endPetDrag(); });
  win.on("focus", () => dispatch("focus"));
  win.webContents.on("did-finish-load", () => {
    petReady = true;
    syncWindows({ focus: state.chatOpen });
  });
  win.webContents.on("render-process-gone", () => {
    if (!quitting) {
      petReady = false;
      win.reload();
    }
  });
  win.on("closed", () => {
    endPetDrag();
    if (petWindow === win) {
      petWindow = undefined;
      petReady = false;
      if (!quitting) createPetWindow();
    }
  });
  win.loadFile(path.join(dirname, "renderer/pet.html"));
}
function createHintWindow() {
  hintReady = false;
  hintMeasurement = undefined;
  const layout = hintLayout(hintMessage);
  const win = new BrowserWindow({
    ...layout.bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: false,
    hasShadow: false,
    webPreferences: hintWebPreferences,
  });
  hintWindow = win;
  raiseWindow(win);
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.on("did-finish-load", () => {
    if (hintWindow !== win) return;
    hintReady = true;
    syncHint();
  });
  win.webContents.on("render-process-gone", () => {
    if (!quitting && hintWindow === win) {
      hintReady = false;
      win.reload();
    }
  });
  win.on("closed", () => {
    if (hintWindow === win) {
      hintWindow = undefined;
      hintReady = false;
      if (!quitting && hintMessage) createHintWindow();
    }
  });
  win.loadFile(path.join(dirname, "renderer/hint.html"));
}
function showApiSettings() {
  interruptInteraction({ preserveMotion: true });
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 480,
    height: 650,
    resizable: false,
    maximizable: false,
    title: t(locale, "settingsTitle", { brand: brand(locale) }),
    backgroundColor: windowBackground(),
    show: false,
    webPreferences: {
      preload: path.join(dirname, "settings-preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  settingsWindow = win;
  bindEditingShortcuts(win);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  win.on("closed", () => {
    settingsWindow = undefined;
  });
  win.loadFile(path.join(dirname, "renderer/settings.html"));
}
function fromSettings(event) {
  return (
    event.sender === settingsWindow?.webContents &&
    event.senderFrame === settingsWindow.webContents.mainFrame
  );
}
for (const [channel, method] of [
  ["load", "status"],
  ["save", "save"],
  ["clear", "clear"],
]) {
  ipcMain.handle("settings:" + channel, (event, value) => {
    if (!fromSettings(event)) return { ok: false, error: "无效的设置窗口。" };
    try {
      return { ok: true, value: apiSettingsStore[method](value) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}
ipcMain.on("settings:close", (event) => {
  if (fromSettings(event)) settingsWindow.close();
});
function rebuildTrayMenu() {
  if (!tray || quitting) return;
  trayMenu = Menu.buildFromTemplate([
    ...[
      [MODES.DODGE, t(locale, "modeDodge")],
      [MODES.PET, t(locale, "modePet")],
      [MODES.BEANS, t(locale, "modeBeans")],
    ].map(([value, label]) => ({
      id: value,
      label: value === MODES.PET ? `${label}  ⓘ` : label,
      ...(value === MODES.PET ? {
        accessibilityLabel: label,
        toolTip: t(locale, "petHelp"),
      } : {}),
      type: "radio",
      checked: state.mode === value,
      click: () => setMode(value),
    })),
    { type: "separator" },
    { id: "characters", label: t(locale, "characters"), click: () => characterLibrary.show() },
    {
      id: "appearance", label: t(locale, "appearance"), submenu: THEMES.map(theme => ({
        id: "theme-" + theme, type: "radio", label: t(locale, theme), checked: preferences().theme === theme,
        click: () => setPreference({ theme }),
      })),
    },
    {
      id: "language", label: t(locale, "language"), submenu: LOCALE_CHOICES.map(choice => ({
        id: "locale-" + choice, type: "radio",
        label: choice === "system" ? t(locale, "localeSystemDetail", { language: t(locale, ({"zh-CN":"langZhCN","zh-TW":"langZhTW",en:"langEn",ja:"langJa",fr:"langFr",de:"langDe",ru:"langRu"})[preferences().resolvedLocale]) }) : t(locale, ({"zh-CN":"langZhCN","zh-TW":"langZhTW",en:"langEn",ja:"langJa",fr:"langFr",de:"langDe",ru:"langRu"})[choice]),
        checked: preferences().locale === choice, click: () => setPreference({ locale: choice }),
      })),
    },
    {
      id: "shortcuts", label: t(locale, "shortcuts"), submenu: [
        { id: "cycle-mode", label: t(locale, "cycleMode"), accelerator: MODE_SHORTCUT, registerAccelerator: false, click: cycleMode },
        { id: "cycle-character", label: t(locale, "cycleCharacter"), accelerator: CHARACTER_SHORTCUT, registerAccelerator: false, click: cycleCharacter },
        { id: "chat", label: t(locale, "chat"), accelerator: CHAT_SHORTCUT, registerAccelerator: false, click: showChat },
        { id: "hide", label: t(locale, state.manualHidden ? "show" : "hide"), accelerator: HIDE_SHORTCUT, registerAccelerator: false, click: toggleHidden },
        { id: "summon", label: t(locale, "summon"), accelerator: HIDE_SHORTCUT, registerAccelerator: false, click: summonPet },
      ],
    },
    { type: "separator" },
    {
      label: t(locale, "login"),
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      enabled: app.isPackaged,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { id: "api-settings", label: t(locale, "chatSettings"), click: showApiSettings },
    { id: "quit", label: t(locale, "quit", { brand: brand(locale) }), click: () => app.quit() },
  ]);
  trayMenu.on("menu-will-show", () => {
    menuOpen = true;
    interruptInteraction({ preserveMotion: true });
  });
  trayMenu.on("menu-will-close", () => {
    menuOpen = false;
  });
  tray.setContextMenu(trayMenu);
  tray.setToolTip(brand(locale) + " · " + state.mode);
  // No tray click callback: opening the menu never reveals or activates the pet.
}
function registerShortcut(accelerator, handler, label) {
  let registered = false;
  try {
    registered = globalShortcut.register(accelerator, handler);
  } catch {
    /* invalid custom accelerator */
  }
  if (!registered) {
    console.error(label + "快捷键注册失败：" + accelerator);
    if (Notification.isSupported())
      new Notification({
        title: t(locale, "shortcutTitle", { brand: brand(locale) }),
        body: t(locale, "shortcutBody", { action: label }),
      }).show();
  }
}
const mascotSource = readFileSync(path.join(dirname, "../assets", BLUE_ONE_EYE.asset), "utf8");
ipcMain.handle("mascot:source", (event) => {
  if ((event.sender !== petWindow?.webContents && event.sender !== gameWindow?.webContents) || event.senderFrame !== event.sender.mainFrame)
    throw new Error("Invalid sender");
  return mascotSource;
});
ipcMain.handle("character:source", event => {
  if ((event.sender !== petWindow?.webContents && event.sender !== gameWindow?.webContents) || event.senderFrame !== event.sender.mainFrame)
    throw new Error("Invalid sender");
  return characterLibrary.source();
});
ipcMain.on("pet:ready", (event) => {
  if (fromPet(event)) {
    petReady = true;
    syncWindows();
  }
});
ipcMain.on("pet:frame", (event) => {
  if (fromPet(event)) tick();
});
function fromPet(event) {
  return (
    event.sender === petWindow?.webContents && event.senderFrame === petWindow.webContents.mainFrame
  );
}
ipcMain.handle("chat:send", async (event, prompt) => {
  if (!fromPet(event)) throw new Error("Invalid sender");
  if (typeof prompt !== "string" || prompt.length > 500 || !prompt.trim()) return { ok: false, error: "noteInvalid" };
  try {
    const result = await reminders.submit(reminderContext => askClaude(prompt, {
      persona: selectedCharacter.profile.persona, locale, reminderContext,
      ...(reminderRequest ? { request: reminderRequest } : {}),
      provider: () => apiSettingsStore.provider() || loadChatProvider(),
    }));
    if (state.chatOpen && result.view) reminderView = result.view;
    sendReminderState();
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: /^note[A-Z]/.test(error.message) ? error.message : "chatFailed" };
  }
});
ipcMain.handle("reminder:get", event => {
  if (!fromPet(event)) throw new Error("Invalid sender");
  return { ...reminders.snapshot(), view: reminderView };
});
ipcMain.handle("reminder:view", (event, view) => {
  if (!fromPet(event) || !["chat", "note"].includes(view)) throw new Error("Invalid request");
  if (view === "chat") {
    try { reminders.dismissDue(); } catch { return { ok: false, error: "noteStorageFailed" }; }
    reminders.dismiss();
  }
  reminderView = view; autoReminder = false;
  sendReminderState();
  return { ok: true };
});
ipcMain.handle("reminder:action", (event, value) => {
  if (!fromPet(event)) throw new Error("Invalid sender");
  try {
    if (!value || typeof value !== "object" || !Number.isSafeInteger(value.revision)) throw new Error("noteInvalid");
    const snapshot = reminders.action(value);
    reminderView = snapshot.note || snapshot.warning ? "note" : "chat";
    if (value.action === "ack") {
      autoReminder = false;
      interruptInteraction(); dispatch("dismiss-chat"); syncWindows();
    }
    sendReminderState();
    return { ok: true, snapshot, view: reminderView };
  } catch (error) { return { ok: false, error: /^note[A-Z]/.test(error.message) ? error.message : "noteInvalid", snapshot: reminders.snapshot() }; }
});
ipcMain.on("chat:dismiss", (event) => {
  if (fromPet(event)) restorePetFrame();
});
ipcMain.on("pet:focus", (event) => {
  if (fromPet(event) && state.mode === MODES.PET && !state.chatOpen && !state.manualHidden)
    syncWindows({ focus: true });
});
ipcMain.on("pet:hover", (event, value) => {
  if (!fromPet(event)) return;
  petHovered = value === true;
  if (petHovered && state.mode === MODES.PET) {
    petReturn.cancel();
    if (modeTransition?.kind === "pet-dodge-return") cancelModeTransition();
    dodge.reset();
    velocity = { x: 0, y: 0 };
  }
});
ipcMain.on("pet:hint", (event, message) => {
  if (fromPet(event)) setHintMessage(message);
});
ipcMain.on("hint:measure", (event, value) => {
  if (event.sender !== hintWindow?.webContents || event.senderFrame !== hintWindow.webContents.mainFrame) return;
  const width = ["zh-CN", "zh-TW", "ja"].includes(locale) ? PET_SIZE : HINT_WESTERN_WIDTH;
  if (!value || !hintMessage || value.message !== hintMessage || value.locale !== locale || value.width !== width ||
      !Number.isInteger(value.height) || value.height < 25 || value.height > 1024) return;
  if (hintMeasurement?.message === value.message && hintMeasurement.locale === value.locale && hintMeasurement.height === value.height) return;
  hintMeasurement = { message: value.message, locale: value.locale, height: value.height };
  syncHint();
});
ipcMain.on("pet:drag", handlePetDrag);
ipcMain.on("pet:hide-done", (event, id) => {
  if (
    hideAnimation &&
    event.sender === hideAnimation.win.webContents &&
    event.senderFrame === event.sender.mainFrame &&
    Number.isSafeInteger(id)
  )
    finishHide(id);
});
ipcMain.on("game:exit", (event) => {
  if (event.sender === gameWindow?.webContents) setMode(MODES.PET);
});

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
app.on("second-instance", (_event, argv) => {
  const next = normalizeMode(argv.find((arg) => arg.startsWith("--mode="))?.split("=")[1]);
  if (Object.values(MODES).includes(next)) setMode(next);
  else summonPet();
});
export const ready = app.whenReady().then(async () => {
  if (!hasLock) return;
  if (process.platform === "darwin") app.dock.hide();
  Menu.setApplicationMenu(null);
  preferencesStore = createPreferencesStore({ directory: app.getPath("userData"), systemLanguages: () => app.getPreferredSystemLanguages() });
  applyPreferences(preferencesStore.get(), { broadcast: false });
  apiSettingsStore = createApiSettingsStore({
    directory: app.getPath("userData"),
    secureStorage: safeStorage,
  });
  reminders = createReminders({
    store: createReminderStore({ directory: app.getPath("userData"), secureStorage: safeStorage }),
    changed: sendReminderState,
  });
  reminderTimer = setInterval(checkReminders, 1000);
  characterLibrary = await createCharacterLibrary({
    directory: app.getPath("userData"),
    bindEditingShortcuts,
    analyzeImage: input => analyzeCharacterImage(input, characterServices()),
    generateFields: (input, onProgress) => generateCharacterFields(input, { ...characterServices(), onProgress }),
    openSettings: showApiSettings,
    onOpen: () => interruptInteraction({ preserveMotion: true }),
    locale: () => locale,
    backgroundColor: windowBackground,
    shouldForceClose: () => quitting,
    onChange: () => {
      const source = characterLibrary.source();
      selectedCharacter = characterDefinition(source.id, source.profile, source.analysis, undefined, locale);
      for (const win of [petWindow, gameWindow]) if (win && !win.isDestroyed()) win.webContents.send("character:changed");
    },
  });
  {
    const source = characterLibrary.source();
    selectedCharacter = characterDefinition(source.id, source.profile, source.analysis, undefined, locale);
  }
  pinPet();
  createPetWindow();
  const trayImage = nativeImage.createFromPath(path.join(dirname, "../assets/tray.png"));
  // macOS owns the tint, including light/dark menu bars and selected menus.
  trayImage.setTemplateImage(true);
  tray = new Tray(trayImage);
  if (trayImage.isEmpty() && process.platform === "darwin") tray.setTitle("宠");
  rebuildTrayMenu();
  registerShortcut(HIDE_SHORTCUT, toggleHidden, t(locale, "shortcutHide"));
  registerShortcut(CHAT_SHORTCUT, showChat, t(locale, "shortcutChat"));
  registerShortcut(MODE_SHORTCUT, cycleMode, t(locale, "shortcutMode"));
  registerShortcut(CHARACTER_SHORTCUT, cycleCharacter, t(locale, "shortcutCharacter"));
  nativeTheme.on("updated", updateNativeSurfaces);
  reducedMotion = systemPreferences.getAnimationSettings().prefersReducedMotion;
  // Recovery is independent of rAF: an unexpectedly hidden window stops its
  // renderer clock, but must still be recoverable. Never unhide a manual hide.
  loop = setInterval(() => {
    reducedMotion = systemPreferences.getAnimationSettings().prefersReducedMotion;
    const ready = state.mode === MODES.BEANS ? gameReady : petReady;
    if (ready && !state.manualHidden && !activeWindow()?.isVisible()) {
      recoverWindows({ relocateGame: false });
    }
  }, 500);
  if (initialMode === MODES.BEANS) syncGame({ focus: true });
  for (const event of ["display-added", "display-removed", "display-metrics-changed"])
    screen.on(event, () => recoverWindows());
  for (const event of ["resume", "unlock-screen"])
    powerMonitor.on(event, () => {
      if (event === "unlock-screen") screenLocked = false;
      else suspended = false;
      recoverWindows();
      checkReminders();
    });
  powerMonitor.on("lock-screen", () => { screenLocked = true; });
  powerMonitor.on("suspend", () => { suspended = true; });
  app.on("activate", () => {
    if (!dragSession) syncWindows();
  });
});
function prepareQuit() {
  quitting = true;
  clearInterval(loop);
  clearInterval(reminderTimer);
  cancelHide();
}
app.on("before-quit", prepareQuit);
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {});

// Test code runs in the main process; this API is not exposed to renderers or a port.
export function getRuntime() {
  return {
    reminders,
    state: { ...state },
    position: { ...position },
    velocity: { ...velocity },
    modeTransition,
    petHome,
    petWindow,
    hintWindow,
    hintMessage,
    gameWindow,
    settingsWindow,
    characterWindow: characterLibrary?.window,
    selectedCharacterId: selectedCharacter.id,
    tray,
    trayMenu,
    preferences: preferences(),
    menuOpen,
    ignoringMouse,
    hiding: Boolean(hideAnimation),
    dragPending: Boolean(dragSession),
    petHovered,
    dodgeMotion,
    petReturn: petReturn.state(performance.now()),
  };
}
export function shutdown(code = 0) {
  prepareQuit();
  globalShortcut.unregisterAll();
  app.exit(code);
}
process.once("SIGTERM", () => shutdown());
process.once("SIGINT", () => shutdown());
