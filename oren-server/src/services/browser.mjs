// ============================================
// BROWSER — Shared Playwright browser instance
// Reuse across scraping jobs to save memory
// ============================================

import { chromium } from "playwright";

let _browser = null;

export async function getBrowser() {
  if (_browser?.isConnected()) return _browser;

  _browser = await chromium.launch({
    headless: process.env.SCRAPE_HEADLESS !== "false",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  return _browser;
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

export async function newPage() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
  });
  return page;
}
