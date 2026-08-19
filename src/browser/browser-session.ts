import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { NetworkPolicy, parseWebUrl } from "../security/network-policy.js";
import type {
  BrowserConfig,
  ImageReference,
  InteractionInput,
  RetrievedImage,
  Snapshot,
  SnapshotOptions,
} from "../types.js";
import { extractSnapshot } from "./extractor.js";

const HEAVY_RESOURCE_TYPES = new Set(["image", "media", "font"]);

export class BrowserSession {
  readonly #config: BrowserConfig;
  readonly #networkPolicy: NetworkPolicy;
  readonly #images = new Map<string, ImageReference>();
  #browser: Browser | undefined;
  #context: BrowserContext | undefined;
  #activePage: Page | undefined;

  constructor(config: BrowserConfig) {
    this.#config = config;
    this.#networkPolicy = new NetworkPolicy(config.allowPrivateHosts);
  }

  async open(url: string, options: SnapshotOptions): Promise<Snapshot> {
    const safeUrl = await this.#networkPolicy.assertAllowed(url);
    const page = await this.#page();
    await page.goto(safeUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: this.#config.navigationTimeoutMs,
    });
    return this.read(options);
  }

  async read(options: SnapshotOptions): Promise<Snapshot> {
    const page = await this.#page();
    const extracted = await extractSnapshot(page, options);
    this.#images.clear();
    for (const image of extracted.images) this.#images.set(image.id, image);
    return extracted.snapshot;
  }

  async interact(input: InteractionInput, options: SnapshotOptions): Promise<Snapshot> {
    const page = await this.#page();
    const locator = input.ref ? page.locator(`[data-haden-ref="${input.ref}"]`).first() : undefined;

    switch (input.action) {
      case "click":
        await this.#requiredLocator(locator, input).click();
        break;
      case "fill":
        await this.#requiredLocator(locator, input).fill(this.#requiredValue(input));
        break;
      case "select":
        await this.#requiredLocator(locator, input).selectOption(this.#requiredValue(input));
        break;
      case "press": {
        const key = input.key?.trim();
        if (!key) throw new Error("The press action requires key");
        if (locator) await locator.press(key);
        else await page.keyboard.press(key);
        break;
      }
      case "scroll": {
        const direction = input.direction ?? "down";
        const amount = input.amount ?? 700;
        if (direction === "top") await page.evaluate(() => scrollTo(0, 0));
        else if (direction === "bottom") await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
        else await page.mouse.wheel(0, direction === "up" ? -amount : amount);
        break;
      }
      case "back":
        await page.goBack({ waitUntil: "domcontentloaded", timeout: this.#config.navigationTimeoutMs });
        break;
      case "forward":
        await page.goForward({ waitUntil: "domcontentloaded", timeout: this.#config.navigationTimeoutMs });
        break;
      case "reload":
        await page.reload({ waitUntil: "domcontentloaded", timeout: this.#config.navigationTimeoutMs });
        break;
      case "wait":
        await page.waitForTimeout(input.waitMs ?? 500);
        break;
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(100);
    return this.read(options);
  }

  async getImage(id: string): Promise<RetrievedImage> {
    const image = this.#images.get(id);
    if (!image) {
      throw new Error(`Unknown image ref: ${id}. Call haden_read again and use one of its current img refs.`);
    }
    if (!image.src) throw new Error(`Image ${id} has no retrievable source URL`);

    const page = await this.#page();
    let mimeType: string;
    let bytes: Buffer;

    if (image.src.startsWith("data:")) {
      ({ mimeType, bytes } = this.#decodeDataUrl(image.src));
    } else if (image.src.startsWith("blob:")) {
      const result = await page.evaluate(async (ref) => {
        const element = document.querySelector(`[data-haden-image-ref="${ref}"]`) as HTMLImageElement | null;
        if (!element?.src) throw new Error("The image element is no longer available");
        const response = await fetch(element.src);
        const blob = await response.blob();
        const array = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        const chunkSize = 32_768;
        for (let offset = 0; offset < array.length; offset += chunkSize) {
          binary += String.fromCharCode(...array.subarray(offset, offset + chunkSize));
        }
        return { mimeType: blob.type, data: btoa(binary) };
      }, id);
      mimeType = result.mimeType;
      bytes = Buffer.from(result.data, "base64");
    } else {
      ({ mimeType, bytes } = await this.#fetchRemoteImage(page, image.src, id));
    }

    if (bytes.byteLength > this.#config.maxImageBytes) {
      throw new Error(`Image ${id} is ${bytes.byteLength} bytes; limit is ${this.#config.maxImageBytes} bytes`);
    }
    mimeType = this.#validatedImageMimeType(mimeType, bytes);

    return {
      id,
      alt: image.alt,
      sourceUrl: image.src,
      mimeType,
      data: bytes.toString("base64"),
      byteLength: bytes.byteLength,
    };
  }

  async status(): Promise<{ running: boolean; url?: string; title?: string }> {
    if (!this.#activePage || this.#activePage.isClosed()) return { running: false };
    return {
      running: true,
      url: this.#activePage.url(),
      title: await this.#activePage.title(),
    };
  }

  async close(): Promise<void> {
    this.#images.clear();
    const browser = this.#browser;
    this.#activePage = undefined;
    this.#context = undefined;
    this.#browser = undefined;
    if (browser) await browser.close();
  }

  async #page(): Promise<Page> {
    await this.#start();
    if (!this.#activePage || this.#activePage.isClosed()) {
      this.#activePage = await this.#context!.newPage();
    }
    return this.#activePage;
  }

  async #start(): Promise<void> {
    if (this.#browser?.isConnected() && this.#context) return;

    try {
      this.#browser = await chromium.launch({ headless: this.#config.headless });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Chromium could not start. Run \"npm run setup-browser\" once after installing haden-browser. ${message}`,
      );
    }

    this.#context = await this.#browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    this.#context.setDefaultTimeout(this.#config.actionTimeoutMs);
    this.#context.setDefaultNavigationTimeout(this.#config.navigationTimeoutMs);

    await this.#context.route("**/*", async (route) => {
      const request = route.request();
      if (this.#config.blockHeavyAssets && HEAVY_RESOURCE_TYPES.has(request.resourceType())) {
        await route.abort("blockedbyclient");
        return;
      }

      const requestUrl = request.url();
      if (!requestUrl.startsWith("http://") && !requestUrl.startsWith("https://")) {
        if (request.isNavigationRequest() && requestUrl !== "about:blank") {
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
        return;
      }
      try {
        await this.#networkPolicy.assertAllowed(requestUrl);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });

    this.#context.on("page", (page) => {
      this.#activePage = page;
    });
    this.#browser.on("disconnected", () => {
      this.#activePage = undefined;
      this.#context = undefined;
      this.#browser = undefined;
    });
  }

  #requiredLocator(locator: ReturnType<Page["locator"]> | undefined, input: InteractionInput) {
    if (!input.ref) throw new Error(`The ${input.action} action requires ref from the latest snapshot`);
    if (!/^e\d+$/.test(input.ref)) throw new Error(`Invalid element ref: ${input.ref}`);
    return locator!;
  }

  #requiredValue(input: InteractionInput): string {
    if (input.value === undefined) throw new Error(`The ${input.action} action requires value`);
    return input.value;
  }

  #decodeDataUrl(value: string): { mimeType: string; bytes: Buffer } {
    const match = /^data:([^,]*?),(.*)$/s.exec(value);
    if (!match) throw new Error("Invalid image data URL");
    const metadata = match[1] ?? "";
    const payload = match[2] ?? "";
    const parts = metadata.split(";");
    const mimeType = parts[0] || "application/octet-stream";
    const bytes = parts.includes("base64")
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return { mimeType, bytes };
  }

  async #fetchRemoteImage(
    page: Page,
    sourceUrl: string,
    id: string,
  ): Promise<{ mimeType: string; bytes: Buffer }> {
    let currentUrl = (await this.#networkPolicy.assertAllowed(sourceUrl)).href;
    let referer = page.url();

    for (let redirectCount = 0; redirectCount <= 10; redirectCount += 1) {
      const response = await page.context().request.get(currentUrl, {
        headers: { referer },
        timeout: this.#config.navigationTimeoutMs,
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      const status = response.status();
      const location = response.headers().location;
      if (status >= 300 && status < 400 && location) {
        if (redirectCount === 10) {
          await response.dispose();
          throw new Error(`Image ${id} exceeded 10 redirects`);
        }
        const redirected = new URL(location, currentUrl).href;
        await response.dispose();
        referer = currentUrl;
        currentUrl = (await this.#networkPolicy.assertAllowed(redirected)).href;
        continue;
      }

      if (!response.ok()) {
        const summary = `${response.status()} ${response.statusText()}`.trim();
        await response.dispose();
        throw new Error(`Image ${id} request failed: ${summary}`);
      }

      const declaredLength = Number(response.headers()["content-length"] ?? "0");
      if (declaredLength > this.#config.maxImageBytes) {
        await response.dispose();
        throw new Error(`Image ${id} is ${declaredLength} bytes; limit is ${this.#config.maxImageBytes} bytes`);
      }
      const mimeType = response.headers()["content-type"]?.split(";")[0]?.trim() ?? "";
      const bytes = await response.body();
      await response.dispose();
      return { mimeType, bytes };
    }

    throw new Error(`Image ${id} could not be retrieved`);
  }

  #validatedImageMimeType(declared: string, bytes: Buffer): string {
    if (declared.startsWith("image/")) return declared;
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    if (bytes.subarray(0, 6).toString("ascii").startsWith("GIF8")) return "image/gif";
    if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
      return "image/webp";
    }
    if (bytes.subarray(0, 512).toString("utf8").includes("<svg")) return "image/svg+xml";
    throw new Error(`The retrieved resource is not a supported image (content-type: ${declared || "unknown"})`);
  }
}
