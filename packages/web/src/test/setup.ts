import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

window.scrollTo = () => {};

let storage: Storage | undefined;
try {
  const nativeStorage = window.localStorage;
  const probe = `vitest-storage-probe-${Math.random()}`;
  nativeStorage.setItem(probe, "ok");
  nativeStorage.removeItem(probe);
  storage = nativeStorage;
} catch {
  const localStorageData = new Map<string, string>();
  storage = {
    getItem: (key: string) => localStorageData.get(key) ?? null,
    setItem: (key: string, value: string) => localStorageData.set(key, value),
    removeItem: (key: string) => localStorageData.delete(key),
    clear: () => localStorageData.clear(),
    get length() {
      return localStorageData.size;
    },
    key: (index: number) => Array.from(localStorageData.keys())[index] ?? null,
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
}

afterEach(() => storage?.clear());

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
