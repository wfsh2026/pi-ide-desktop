import { isTauri } from "@tauri-apps/api/core";

function internals() {
  if (typeof window === "undefined") return null;
  return window.__TAURI_INTERNALS__ || null;
}

export function hasTauriInvokeRuntime() {
  const api = internals();
  return Boolean(isTauri() && api && typeof api.invoke === "function");
}

export function hasTauriEventRuntime() {
  const api = internals();
  const eventApi = typeof window === "undefined" ? null : window.__TAURI_EVENT_PLUGIN_INTERNALS__;
  return Boolean(
    hasTauriInvokeRuntime()
    && typeof api.transformCallback === "function"
    && eventApi
    && typeof eventApi.unregisterListener === "function"
  );
}

export function hasTauriWebviewRuntime() {
  const api = internals();
  return Boolean(
    hasTauriEventRuntime()
    && api.metadata?.currentWindow?.label
    && api.metadata?.currentWebview?.label
  );
}

export function trackAsyncUnsubscribe(subscription, unsubs, onError = () => {}) {
  let disposed = false;
  Promise.resolve(subscription)
    .then((unsubscribe) => {
      if (typeof unsubscribe !== "function") return;
      if (disposed) unsubscribe();
      else unsubs.push(unsubscribe);
    })
    .catch(onError);

  return () => {
    disposed = true;
  };
}
