'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const puppeteer = require('puppeteer');

test('Puppeteer launches its managed browser without a system Chrome install', async () => {
  const executablePath = puppeteer.executablePath();
  assert.ok(fs.existsSync(executablePath), `Managed browser is missing: ${executablePath}. Run npm run browser:install.`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><title>E-Chat browser check</title><main id="status">ready</main>');
    assert.equal(await page.title(), 'E-Chat browser check');
    assert.equal(await page.$eval('#status', (element) => element.textContent), 'ready');
    assert.match(await page.evaluate(() => navigator.userAgent), /Chrome|Chromium/);
  } finally {
    await browser.close();
  }
});
