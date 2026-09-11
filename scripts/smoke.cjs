// Real CDN + WebAssembly smoke check; intentionally separate from offline CI tests.
const { chromium } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { mkdirSync } = require('node:fs');
(async () => {
  const server = spawn('python', ['-m', 'http.server', '8123', '--bind', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
  let browser;
  try {
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => console.error(`Request failed: ${request.url()} ${request.failure()?.errorText}`));
    await page.goto('http://127.0.0.1:8123');
    await page.waitForFunction(() => /Python готов|Ошибка загрузки/.test(document.querySelector('#engineStatus').textContent), null, { timeout: 120000 });
    if (await page.locator('#engineStatus').evaluate(el => el.classList.contains('error'))) {
      throw new Error(await page.locator('#consoleOutput').textContent());
    }
    await page.evaluate(() => editor.setValue('total = 0\nfor i in range(4):\n    total += i\nprint(total)', -1));
    await page.waitForFunction(() => document.querySelectorAll('.code-node').length === 4);
    await page.locator('#speedRange').fill('120');
    await page.locator('#runBtn').click();
    await page.waitForFunction(() => document.querySelector('#consoleOutput').textContent.includes('Выполнение завершено'));
    const output = await page.locator('.console-line').last().textContent();
    if (output !== '6' || errors.length) throw new Error(JSON.stringify({ output, errors }));
    mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/live-desktop.png' });
    console.log('PASS: real Ace CDN, Pyodide WebAssembly, Python AST and loop execution → 6.');
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
