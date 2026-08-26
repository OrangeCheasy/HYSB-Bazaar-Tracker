/**
 * Responsive check: screenshot every route at a set of widths and report any horizontal
 * overflow, naming the elements responsible.
 *
 * Written because four sessions of markup tests asserted the mobile layout was correct and
 * none of them could have caught a table wider than the viewport — a rule that a figure
 * must be "adjacent and visible" is not satisfied by being in the DOM 40px past the right
 * edge.
 *
 * It uses the DevTools Protocol viewport override rather than `--window-size`, because
 * Chrome on Windows enforces a minimum window width of around 500px: passing
 * `--window-size=375` lays the page out at ~485 and then screenshots the left 375 of it,
 * which looks exactly like an overflow bug and is not one. That false positive cost an
 * hour, so this script exists partly to make sure nobody pays it twice.
 *
 * Usage: node scripts/shoot.mjs [baseUrl]
 */

import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const OUT = "shots";

const CHROME =
  process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

/** 375 is the stated floor (ROADMAP Phase 5). 768 catches the tablet gap between the
 *  mobile grid and the desktop table; 1440 is the ordinary desktop case. */
const WIDTHS = [375, 768, 1440];

const ROUTES = [
  ["landing", "/"],
  ["scan", "/scan"],
  ["band-detail", "/bands/COAL"],
  ["craft-detail", "/craft/ENCHANTMENT_ULTIMATE_WISE_5"],
  ["craft-compact", "/craft/COAL"],
  ["items", "/items"],
  ["item-detail", "/item/COAL"],
];

/**
 * Elements sticking out past the viewport, named well enough to find in the source.
 *
 * Serialised and run inside the page by `page.evaluate`, not in node — hence the browser
 * globals, which the lint environment for scripts/ has no reason to know about.
 */
/* global document */
function findOverflow() {
  const limit = document.documentElement.clientWidth;
  const guilty = [];
  for (const el of document.querySelectorAll("body *")) {
    const right = el.getBoundingClientRect().right;
    if (right > limit + 1) {
      const cls = typeof el.className === "string" ? el.className : "";
      guilty.push(`${el.tagName.toLowerCase()}.${cls.slice(0, 70)} @${Math.round(right)}`);
    }
    if (guilty.length >= 8) break;
  }
  return {
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: limit,
    guilty,
  };
}

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
});

let failures = 0;

for (const width of WIDTHS) {
  for (const [name, route] of ROUTES) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900, deviceScaleFactor: 2 });
    await page.goto(BASE + route, { waitUntil: "networkidle0", timeout: 30_000 });
    // The charts arrive in a lazily-loaded chunk, so networkidle0 is not enough on a
    // detail route — give the Suspense boundary a beat to resolve and lay out.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const report = await page.evaluate(findOverflow);
    const overflowing = report.scrollWidth > report.clientWidth + 1;
    if (overflowing) failures++;

    console.log(
      `${String(width).padStart(4)}px ${name.padEnd(14)} ` +
        `scroll ${String(report.scrollWidth).padStart(5)} / client ${String(report.clientWidth).padStart(5)} ` +
        (overflowing ? `OVERFLOW: ${report.guilty.join(" | ")}` : "ok"),
    );

    await page.screenshot({ path: `${OUT}/${name}-${width}.png`, fullPage: false });
    await page.close();
  }
}

await browser.close();
console.log(
  failures === 0 ? "\nno horizontal overflow at any width" : `\n${failures} overflowing`,
);
process.exit(failures === 0 ? 0 : 1);
