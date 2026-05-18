import assert from "node:assert/strict";
import {
  hasTauriEventRuntime,
  hasTauriInvokeRuntime,
  hasTauriWebviewRuntime,
  trackAsyncUnsubscribe
} from "./tauriRuntime.js";

const originalWindow = globalThis.window;
const originalIsTauri = globalThis.isTauri;

function setWindow(value) {
  if (value === undefined) delete globalThis.window;
  else globalThis.window = value;
}

try {
  delete globalThis.isTauri;
  setWindow(undefined);
  assert.equal(hasTauriInvokeRuntime(), false);
  assert.equal(hasTauriEventRuntime(), false);
  assert.equal(hasTauriWebviewRuntime(), false);

  globalThis.isTauri = true;
  setWindow({ __TAURI_INTERNALS__: { invoke() {} } });
  assert.equal(hasTauriInvokeRuntime(), true);
  assert.equal(hasTauriEventRuntime(), false);
  assert.equal(hasTauriWebviewRuntime(), false);

  globalThis.window.__TAURI_INTERNALS__.transformCallback = () => 1;
  globalThis.window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  assert.equal(hasTauriEventRuntime(), true);
  assert.equal(hasTauriWebviewRuntime(), false);

  globalThis.window.__TAURI_INTERNALS__.metadata = {
    currentWindow: { label: "main" },
    currentWebview: { label: "main" }
  };
  assert.equal(hasTauriWebviewRuntime(), true);

  let lateUnsubscribed = 0;
  let resolveLate;
  const lateSubscription = new Promise((resolve) => { resolveLate = resolve; });
  const lateUnsubs = [];
  const disposeLate = trackAsyncUnsubscribe(lateSubscription, lateUnsubs);
  disposeLate();
  resolveLate(() => { lateUnsubscribed += 1; });
  await Promise.resolve();
  assert.equal(lateUnsubs.length, 0);
  assert.equal(lateUnsubscribed, 1);

  let activeUnsubscribed = 0;
  const activeUnsubs = [];
  trackAsyncUnsubscribe(Promise.resolve(() => { activeUnsubscribed += 1; }), activeUnsubs);
  await Promise.resolve();
  assert.equal(activeUnsubs.length, 1);
  activeUnsubs[0]();
  assert.equal(activeUnsubscribed, 1);
} finally {
  if (originalIsTauri === undefined) delete globalThis.isTauri;
  else globalThis.isTauri = originalIsTauri;
  setWindow(originalWindow);
}

console.log("tauri runtime ok");
