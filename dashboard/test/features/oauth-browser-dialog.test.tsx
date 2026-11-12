/**
 * OAuth browser dialog step-2 field: drag-and-drop file reading, and
 * invalid-paste handling that resets the input instead of closing the modal.
 *
 * The dialog renders through `createPortal` into `document.body`, so all
 * assertions use the `mount` queries (which fall back to the document) rather
 * than the container.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createElement } from "react";
import { OAuthBrowserDialog } from "../../src/features/provider-detail/sections/OAuthDialogs";
import { toast } from "../../src/lib/toast";
import { mount, stubFetch } from "../helpers/render";

const originalFetch = globalThis.fetch;
const originalFileReader = globalThis.FileReader;
const popup = { close: () => {} } as unknown as Window;

const VALID_PASTE = "http://127.0.0.1:59653/callback?code=abc123&state=xyz";

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.FileReader = originalFileReader;
});

/** A `FileReader` stub that resolves synchronously to a fixed text. */
class FakeFileReader {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  readAsText(file: File) {
    this.result = (file as unknown as { text?: string }).text ?? VALID_PASTE;
    this.onload?.();
  }
}

function renderDialog() {
  const fetchStub = stubFetch([
    { match: "/providers/oa-provider/accounts", json: [] },
    { match: "/providers/oa-provider/oauth/callback", json: { message: "ok" } },
  ]);
  const onClose = mock(() => {});
  const closePopup = spyOn(popup, "close");
  globalThis.FileReader = FakeFileReader as unknown as typeof FileReader;
  return {
    onClose,
    closePopup,
    async mount() {
      return mount(
        createElement(OAuthBrowserDialog, {
          providerId: "oa-provider",
          authorizeUrl: "https://provider.example/authorize?x=1",
          state: "xyz",
          popup,
          onClose,
        }),
      );
    },
    restore() {
      fetchStub.restore();
    },
  };
}

function buttonByText(view: { findAll(selector: string): Element[] }, text: string): HTMLButtonElement {
  const buttons = view.findAll("button");
  const found = buttons.find((button) => button.textContent?.includes(text));
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

function connectButton(view: { findAll(selector: string): Element[] }): HTMLButtonElement {
  return buttonByText(view, "Connect");
}

async function pasteIntoField(
  view: {
    findAll(selector: string): Element[];
    act<T>(body: () => T | Promise<T>): Promise<T>;
    flush(): Promise<void>;
  },
  url: string,
) {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { readText: async () => url },
  });
  await view.act(async () => {
    buttonByText(view, "Paste").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await view.flush();
}

function dropFile(view: { find(selector: string): Element | null }, file: unknown) {
  const zone = view.find("textarea")!.parentElement!;
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { files: [file] } });
  zone.dispatchEvent(drop);
}

/** Dispatch a text drop (no file) on the textarea's drop zone. */
function dropText(view: { find(selector: string): Element | null }, text: string) {
  const zone = view.find("textarea")!.parentElement!;
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { files: [], getData: () => text } });
  zone.dispatchEvent(drop);
}

describe("OAuthBrowserDialog drag-and-drop", () => {
  test("reads a dropped file into the field", async () => {
    const ctx = renderDialog();
    const view = await ctx.mount();
    try {
      const success = spyOn(toast, "success").mockImplementation(() => "success");
      dropFile(view, { name: "redirect.txt", size: 24, type: "text/plain", text: VALID_PASTE });
      await view.flush();
      expect((view.find("textarea") as HTMLTextAreaElement).value).toBe(VALID_PASTE);
      expect(success).toHaveBeenCalledWith("Loaded redirect URL", "Read from redirect.txt");
    } finally {
      view.unmount();
      ctx.restore();
    }
  });

  test("an invalid dropped file empties the field and keeps the modal open", async () => {
    const ctx = renderDialog();
    const view = await ctx.mount();
    try {
      const error = spyOn(toast, "error").mockImplementation(() => "error");
      dropFile(view, {
        name: "broken.txt",
        size: 24,
        type: "text/plain",
        text: "https://provider.example/redirect-without-code",
      });
      await view.flush();
      expect((view.find("textarea") as HTMLTextAreaElement).value).toBe("");
      expect(error).toHaveBeenCalled();
      expect(ctx.onClose).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      ctx.restore();
    }
  });
});

describe("OAuthBrowserDialog invalid paste", () => {
  test("resets the input and keeps the modal open on an invalid paste", async () => {
    const ctx = renderDialog();
    const view = await ctx.mount();
    try {
      const error = spyOn(toast, "error").mockImplementation(() => "error");
      await pasteIntoField(view, "https://provider.example/redirect-without-code");
      expect(connectButton(view).disabled).toBe(false);
      await view.act(async () => {
        connectButton(view).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await view.flush();
      // Invalid paste resets the field (Connect disabled again) and keeps the
      // modal open.
      expect(connectButton(view).disabled).toBe(true);
      expect(error).toHaveBeenCalledWith("OAuth callback failed", expect.any(String));
      expect(ctx.onClose).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      ctx.restore();
    }
  });

  test("a valid paste still connects, closes the popup, and closes the dialog", async () => {
    const ctx = renderDialog();
    ctx.closePopup.mockClear();
    const view = await ctx.mount();
    try {
      await pasteIntoField(view, VALID_PASTE);
      expect(connectButton(view).disabled).toBe(false);
      await view.act(async () => {
        connectButton(view).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await view.flush();
      expect(ctx.onClose).toHaveBeenCalledWith(true);
      expect(ctx.closePopup).toHaveBeenCalled();
    } finally {
      view.unmount();
      ctx.restore();
    }
  });
});

describe("OAuthBrowserDialog text drop", () => {
  test("accepts a dropped redirect URL text into the field", async () => {
    const ctx = renderDialog();
    const view = await ctx.mount();
    try {
      const success = spyOn(toast, "success").mockImplementation(() => "success");
      await view.act(async () => {
        dropText(view, VALID_PASTE);
      });
      await view.flush();
      expect((view.find("textarea") as HTMLTextAreaElement).value).toBe(VALID_PASTE);
      expect(connectButton(view).disabled).toBe(false);
      expect(success).toHaveBeenCalled();
    } finally {
      view.unmount();
      ctx.restore();
    }
  });

  test("an invalid dropped text empties the field and keeps the modal open", async () => {
    const ctx = renderDialog();
    const view = await ctx.mount();
    try {
      const error = spyOn(toast, "error").mockImplementation(() => "error");
      await view.act(async () => {
        dropText(view, "https://provider.example/redirect-without-code");
      });
      await view.flush();
      expect((view.find("textarea") as HTMLTextAreaElement).value).toBe("");
      expect(connectButton(view).disabled).toBe(true);
      expect(error).toHaveBeenCalledWith("Invalid OAuth paste", expect.any(String));
      expect(ctx.onClose).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      ctx.restore();
    }
  });
});

describe("OAuthBrowserDialog popup mode", () => {
  test("completes by pasting the redirect URL", async () => {
    const ctx = renderDialog();
    const view = await ctx.mount();
    try {
      await pasteIntoField(view, VALID_PASTE);
      expect(connectButton(view).disabled).toBe(false);
      await view.act(async () => {
        connectButton(view).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await view.flush();
      expect(ctx.onClose).toHaveBeenCalledWith(true);
      expect(ctx.closePopup).toHaveBeenCalled();
    } finally {
      view.unmount();
      ctx.restore();
    }
  });
});
