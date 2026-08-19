import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractSnapshot } from "../src/browser/extractor.js";

describe("page extraction", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  it("creates compact text with action refs and image placeholders", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <!doctype html>
      <title>Test page</title>
      <style>img { width: 80px; height: 40px } .gone { display: none }</style>
      <main>
        <h1>Hello browser</h1>
        <p>Read <a href="https://example.com/docs">the docs</a> today.</p>
        <img alt="Map preview" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
        <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
        <button>Continue</button>
        <label>Email <input name="email" placeholder="you@example.com"></label>
        <p class="gone">secret hidden copy</p>
      </main>
    `);

    const { snapshot, images } = await extractSnapshot(page, { mode: "text", maxChars: 10_000 });
    expect(snapshot.title).toBe("Test page");
    expect(snapshot.content).toContain("# Hello browser");
    expect(snapshot.content).toContain('[e1] link "the docs"');
    expect(snapshot.content).toContain('[image img1: "Map preview"]');
    expect(snapshot.content).toContain("[image img2]");
    expect(snapshot.content).toContain('[e2] button "Continue"');
    expect(snapshot.content).not.toContain("secret hidden copy");
    expect(snapshot.interactiveCount).toBe(3);
    expect(images).toHaveLength(2);
    await page.close();
  });

  it("removes executable content and image sources from DOM view", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main><script>bad()</script><img style="width: 20px; height: 20px" alt="Logo" src="data:image/png;base64,AA=="></main>
    `);

    const { snapshot } = await extractSnapshot(page, { mode: "dom", maxChars: 10_000 });
    expect(snapshot.content).toContain('<haden-image ref="img1" alt="Logo">');
    expect(snapshot.content).not.toContain("<script");
    expect(snapshot.content).not.toContain("data:image");
    await page.close();
  });

  it("returns bounded computed style details in visual view", async () => {
    const page = await browser.newPage();
    await page.setContent(`<style>h1 { color: rgb(255, 0, 0); padding: 4px }</style><main><h1>Visual</h1></main>`);

    const { snapshot } = await extractSnapshot(page, { mode: "visual", maxChars: 10_000 });
    expect(snapshot.content).toContain('<h1> "Visual" | box=');
    expect(snapshot.content).toContain("color=rgb(255, 0, 0)");
    expect(snapshot.content).toContain("padding=4px");
    await page.close();
  });
});
