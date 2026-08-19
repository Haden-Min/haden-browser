import type { Page } from "playwright";

import type { ImageReference, Snapshot, SnapshotOptions } from "../types.js";
import { normalizeText, truncateText } from "../utils/text.js";

export interface ExtractedSnapshot {
  snapshot: Snapshot;
  images: ImageReference[];
}

interface BrowserExtraction {
  title: string;
  url: string;
  content: string;
  images: ImageReference[];
  interactiveCount: number;
}

export async function extractSnapshot(page: Page, options: SnapshotOptions): Promise<ExtractedSnapshot> {
  const result = await page.evaluate(
    ({ mode, selector }): BrowserExtraction => {
      const selectedRoot = selector ? document.querySelector(selector) : document.body;
      if (!selectedRoot) {
        throw new Error(selector ? `No element matches selector: ${selector}` : "The page has no body element");
      }

      document.querySelectorAll("[data-haden-ref]").forEach((element) => {
        element.removeAttribute("data-haden-ref");
      });
      document.querySelectorAll("[data-haden-image-ref]").forEach((element) => {
        element.removeAttribute("data-haden-image-ref");
      });

      const root = selectedRoot as HTMLElement;
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const visible = (element: Element): boolean => {
        const htmlElement = element as HTMLElement;
        const style = getComputedStyle(htmlElement);
        const box = htmlElement.getBoundingClientRect();
        return (
          !htmlElement.hidden &&
          element.getAttribute("aria-hidden") !== "true" &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || "1") !== 0 &&
          (box.width > 0 || box.height > 0 || style.position === "fixed")
        );
      };

      const labelFor = (element: Element): string => {
        const id = element.getAttribute("id");
        const explicit = id
          ? Array.from(document.querySelectorAll("label")).find(
              (label) => label.getAttribute("for") === id,
            )?.textContent
          : undefined;
        const wrapping = element.closest("label")?.textContent;
        return normalize(explicit ?? wrapping ?? "");
      };

      const accessibleName = (element: Element): string => {
        const htmlElement = element as HTMLElement;
        const input = element as HTMLInputElement;
        const nestedImageAlt = Array.from(element.querySelectorAll("img"))
          .map((image) => image.alt || image.getAttribute("aria-label") || "")
          .filter(Boolean)
          .join(" ");
        const candidates = [
          element.getAttribute("aria-label"),
          element.getAttribute("alt"),
          element.getAttribute("title"),
          labelFor(element),
          htmlElement.innerText,
          nestedImageAlt,
          input.placeholder,
          input.type !== "password" ? input.value : "",
          element.getAttribute("name"),
        ];
        return normalize(candidates.find((candidate) => candidate && normalize(candidate)) ?? "").slice(0, 180);
      };

      const interactiveSelector = [
        "a[href]",
        "button",
        "input:not([type='hidden'])",
        "select",
        "textarea",
        "summary",
        "[contenteditable='true']",
        "[role='button']",
        "[role='link']",
        "[role='checkbox']",
        "[role='radio']",
        "[role='tab']",
        "[role='menuitem']",
        "[role='option']",
      ].join(",");

      const interactiveElements = Array.from(root.querySelectorAll(interactiveSelector)).filter(visible);
      if (root.matches(interactiveSelector) && visible(root)) interactiveElements.unshift(root);
      interactiveElements.forEach((element, index) => {
        element.setAttribute("data-haden-ref", `e${index + 1}`);
      });

      const imageElements = Array.from(root.querySelectorAll("img")).filter(visible) as HTMLImageElement[];
      if (root.matches("img") && visible(root)) imageElements.unshift(root as unknown as HTMLImageElement);
      const images = imageElements.map((image, index): ImageReference => {
        const id = `img${index + 1}`;
        image.setAttribute("data-haden-image-ref", id);
        return {
          id,
          alt: normalize(image.alt || image.getAttribute("aria-label") || ""),
          src: (() => {
            const candidate =
              image.currentSrc ||
              image.getAttribute("src") ||
              image.getAttribute("data-src") ||
              image.getAttribute("data-original") ||
              "";
            if (!candidate) return "";
            try {
              return new URL(candidate, document.baseURI).href;
            } catch {
              return candidate;
            }
          })(),
          width: Math.round(image.getBoundingClientRect().width || image.width || 0),
          height: Math.round(image.getBoundingClientRect().height || image.height || 0),
        };
      });

      const describeInteractive = (element: Element): string => {
        const ref = element.getAttribute("data-haden-ref") ?? "?";
        const tag = element.tagName.toLowerCase();
        const role = element.getAttribute("role") || (tag === "a" ? "link" : tag);
        const name = accessibleName(element);
        const details: string[] = [`[${ref}]`, role, name ? `"${name}"` : "(unnamed)"];
        if (element instanceof HTMLInputElement) {
          details.push(`type=${element.type || "text"}`);
          if (element.type !== "password" && element.value) details.push(`value="${normalize(element.value)}"`);
          if (element.checked) details.push("checked");
        }
        if (element instanceof HTMLAnchorElement && element.href) details.push(`-> ${element.href}`);
        if ((element as HTMLButtonElement).disabled) details.push("disabled");
        const nestedImages = Array.from(element.querySelectorAll("[data-haden-image-ref]"))
          .map((image) => describeImage(image))
          .join(", ");
        if (nestedImages) details.push(`contains=${nestedImages}`);
        return details.join(" ");
      };

      const describeImage = (element: Element): string => {
        const id = element.getAttribute("data-haden-image-ref") ?? "img?";
        const image = images.find((candidate) => candidate.id === id);
        return image?.alt ? `[image ${id}: "${image.alt}"]` : `[image ${id}]`;
      };

      const textView = (): string => {
        const output: string[] = [];
        const blockTags = new Set([
          "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DIV", "DL", "DT", "FIELDSET",
          "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER",
          "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT",
          "TH", "THEAD", "TR", "UL",
        ]);
        const skippedTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME"]);

        const newline = (): void => {
          if (output.length > 0 && output[output.length - 1] !== "\n") output.push("\n");
        };

        const walk = (node: Node): void => {
          if (node.nodeType === Node.TEXT_NODE) {
            const text = normalize(node.textContent ?? "");
            if (text) output.push(`${text} `);
            return;
          }
          if (!(node instanceof Element) || skippedTags.has(node.tagName) || !visible(node)) return;

          const imageRef = node.getAttribute("data-haden-image-ref");
          if (imageRef) {
            output.push(`${describeImage(node)} `);
            return;
          }

          const interactiveRef = node.getAttribute("data-haden-ref");
          if (interactiveRef) {
            output.push(`${describeInteractive(node)} `);
            return;
          }

          const headingLevel = /^H([1-6])$/.exec(node.tagName)?.[1];
          const isBlock = blockTags.has(node.tagName);
          if (isBlock) newline();
          if (headingLevel) output.push(`${"#".repeat(Number(headingLevel))} `);
          if (node.tagName === "LI") output.push("- ");
          for (const child of node.childNodes) walk(child);
          if (isBlock) newline();
        };

        walk(root);
        return output.join("");
      };

      const domView = (): string => {
        const clone = root.cloneNode(true) as Element;
        clone.querySelectorAll("script, style, noscript, template, svg, canvas, iframe, object, embed").forEach((node) => {
          node.remove();
        });
        clone.querySelectorAll("*").forEach((element) => {
          for (const attribute of Array.from(element.attributes)) {
            if (
              attribute.name.toLowerCase().startsWith("on") ||
              ["style", "srcset", "integrity", "nonce"].includes(attribute.name.toLowerCase())
            ) {
              element.removeAttribute(attribute.name);
            }
          }
          if (element instanceof HTMLInputElement && element.type === "password") {
            element.removeAttribute("value");
          }
        });
        clone.querySelectorAll("img").forEach((image) => {
          const replacement = document.createElement("haden-image");
          const id = image.getAttribute("data-haden-image-ref") ?? "unavailable";
          replacement.setAttribute("ref", id);
          const alt = image.getAttribute("alt");
          if (alt) replacement.setAttribute("alt", alt);
          replacement.textContent = alt ? `[image ${id}: "${normalize(alt)}"]` : `[image ${id}]`;
          image.replaceWith(replacement);
        });
        clone.querySelectorAll("source").forEach((source) => source.remove());
        return clone.outerHTML;
      };

      const visualView = (): string => {
        const meaningfulTags = new Set([
          "A", "ARTICLE", "ASIDE", "BUTTON", "DIALOG", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5",
          "H6", "HEADER", "IMG", "INPUT", "LI", "MAIN", "NAV", "P", "SECTION", "SELECT", "TABLE", "TEXTAREA",
        ]);
        const candidates = [root, ...Array.from(root.querySelectorAll("*"))]
          .filter((element) => visible(element))
          .filter(
            (element) =>
              meaningfulTags.has(element.tagName) ||
              element.hasAttribute("data-haden-ref") ||
              element.hasAttribute("data-haden-image-ref"),
          )
          .slice(0, 600);

        return candidates
          .map((element) => {
            const style = getComputedStyle(element);
            const box = (element as HTMLElement).getBoundingClientRect();
            const ref = element.getAttribute("data-haden-ref");
            const imageRef = element.getAttribute("data-haden-image-ref");
            const identity = ref ? ` ref=${ref}` : imageRef ? ` ref=${imageRef}` : "";
            const name = imageRef ? describeImage(element) : accessibleName(element);
            const styleParts = [
              `box=${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)}x${Math.round(box.height)}`,
              `display=${style.display}`,
              `position=${style.position}`,
              `color=${style.color}`,
              `background=${style.backgroundColor}`,
              `font=${style.fontWeight} ${style.fontSize}/${style.lineHeight} ${style.fontFamily}`,
              `margin=${style.margin}`,
              `padding=${style.padding}`,
              `border=${style.border}`,
            ];
            return `<${element.tagName.toLowerCase()}${identity}>${name ? ` "${normalize(name).slice(0, 180)}"` : ""} | ${styleParts.join("; ")}`;
          })
          .join("\n");
      };

      return {
        title: document.title,
        url: location.href,
        content: mode === "text" ? textView() : mode === "dom" ? domView() : visualView(),
        images,
        interactiveCount: interactiveElements.length,
      };
    },
    { mode: options.mode, selector: options.selector },
  );

  const normalized = options.mode === "dom" ? result.content.trim() : normalizeText(result.content);
  const clipped = truncateText(normalized, options.maxChars);
  return {
    snapshot: {
      url: result.url,
      title: result.title,
      mode: options.mode,
      content: clipped.text,
      imageCount: result.images.length,
      interactiveCount: result.interactiveCount,
      truncated: clipped.truncated,
    },
    images: result.images,
  };
}
