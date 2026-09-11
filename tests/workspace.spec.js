const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const starter = readFileSync('app.js', 'utf8').match(/const STARTER_CODE = `([\s\S]*?)`;/)[1].replace(/\r\n/g, '\n');
const simple = 'x = 1\ny = 2\nprint(x + y)';
const loop = 'total = 0\nfor i in range(4):\n    total += i\nprint(total)';
const input = 'name = input("Name: ")\nprint(name)';
const fixtures = {};
for (const source of [starter, simple, loop, input, 'broken =', '']) {
  const result = spawnSync('python', ['-c', 'import sys; from engine import parse_program; print(parse_program(sys.stdin.read()))'],
    { input: source, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (result.status !== 0) throw new Error(result.stderr);
  fixtures[source] = JSON.parse(result.stdout);
}

test.beforeEach(async ({ page }) => {
  await page.route('https://cdn.jsdelivr.net/npm/ace-builds@1.44.0/src-min-noconflict/**', route =>
    route.fulfill({ path: path.join(__dirname, '../node_modules/ace-builds/src-min-noconflict', new URL(route.request().url()).pathname.split('/').at(-1)), contentType: 'text/javascript' }));
  await page.route('https://cdn.jsdelivr.net/pyodide/**', route => route.fulfill({ contentType: 'text/javascript', body:
    `window.loadPyodide = async () => ({ runPython() {}, globals: { get: () => source => JSON.stringify((${JSON.stringify(fixtures)})[source] || {ok:false,error:'Unknown test fixture'}) } });` }));
  await page.goto('/');
  await expect(page.locator('#engineStatus')).toContainText('Python готов');
  await expect(page.locator('.code-node')).not.toHaveCount(0);
});

async function setCode(page, source) {
  await page.evaluate(source => editor.setValue(source, -1), source);
  await expect(page.locator('#parseBadge')).toHaveClass(/ok/);
  await expect(page.locator('.code-node')).toHaveCount(fixtures[source].nodes.length);
}

test('search, navigation, shortcuts and responsive workspace', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.keyboard.press('Control+k');
  await expect(page.locator('#nodeSearch')).toBeFocused();
  await page.locator('#nodeSearch').fill('points');
  await expect(page.locator('#graphSummary')).toContainText('Найдено 4');
  await page.keyboard.press('Enter');
  await expect(page.locator('.selected-node')).toHaveCount(1);
  await page.locator('#nodeSearch').fill('not-present');
  await expect(page.locator('#graphSummary')).toContainText('Найдено 0');
  await page.locator('#helpBtn').click();
  await expect(page.locator('#helpDialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('#nodeSearch').fill('');
  await page.screenshot({ path: 'test-results/workspace-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/workspace-mobile.png', fullPage: true });
  expect((await page.locator('.console-panel').boundingBox()).height).toBeGreaterThan(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('group alignment, distribution, undo, redo and persistence', async ({ page }) => {
  await setCode(page, simple);
  await page.locator('#graphScroll').focus();
  await page.keyboard.press('Control+a');
  await expect(page.locator('.selected-node')).toHaveCount(3);
  await page.locator('#alignNodes').selectOption('top');
  const ys = await page.evaluate(() => [...nodeLayout.values()].map(b => b.y));
  expect(new Set(ys).size).toBe(1);
  await page.locator('#alignNodes').selectOption('horizontal');
  const boxes = await page.evaluate(() => [...nodeLayout.values()]);
  expect(boxes[1].x).toBeGreaterThanOrEqual(boxes[0].x + boxes[0].width + 24);
  await page.locator('#undoLayoutBtn').click();
  await page.locator('#redoLayoutBtn').click();
  const positions = await page.evaluate(() => snapshotLayout());
  await page.reload();
  await expect(page.locator('.code-node')).toHaveCount(3);
  expect(await page.evaluate(() => snapshotLayout())).toEqual(positions);
});

test('zoom-aware group drag, keyboard movement and fit', async ({ page }) => {
  await setCode(page, simple);
  await page.locator('#followNode').uncheck();
  await page.evaluate(() => setGraphZoom(.5));
  await page.locator('#graphScroll').focus();
  await page.keyboard.press('Control+a');
  const before = await page.evaluate(() => snapshotLayout());
  const rect = await page.locator('.code-node').first().boundingBox();
  await page.mouse.move(rect.x + 30, rect.y + 20);
  await page.mouse.down(); await page.mouse.move(rect.x + 80, rect.y + 50, { steps: 5 }); await page.mouse.up();
  const after = await page.evaluate(() => snapshotLayout());
  for (let i = 0; i < before.length; i++) {
    expect(after[i][1].x - before[i][1].x).toBeCloseTo(100, 0);
    expect(after[i][1].y - before[i][1].y).toBeCloseTo(60, 0);
  }
  await page.locator('#graphScroll').focus();
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => snapshotLayout())).toEqual(before);
  await page.keyboard.press('ArrowRight');
  expect((await page.evaluate(() => snapshotLayout()))[0][1].x).toBe(before[0][1].x + 10);
  await page.keyboard.press('f');
  expect(await page.evaluate(() => graphZoom)).toBeLessThanOrEqual(1);
});

test('execution, input, edit cancellation and syntax error recovery', async ({ page }) => {
  await setCode(page, input);
  await page.keyboard.press('F10');
  await expect(page.locator('#inputForm')).toBeVisible();
  await expect(page.locator('#runBtn')).toBeDisabled();
  await page.locator('#inputField').fill('Ada');
  await page.locator('#inputForm button').click();
  await page.keyboard.press('F10');
  await expect(page.locator('#consoleOutput')).toContainText('Ada');
  await setCode(page, loop);
  await page.locator('#clearConsoleBtn').click();
  await page.locator('#speedRange').fill('120');
  await page.locator('#runBtn').click();
  await expect(page.locator('#consoleOutput')).toContainText('Выполнение завершено');
  await expect(page.locator('.console-line').last()).toHaveText('6');
  await page.locator('#runBtn').click();
  await page.evaluate(() => editor.setValue('broken =', -1));
  await expect(page.locator('#parseBadge')).toHaveClass(/bad/);
  await expect(page.locator('#runBtn')).toBeDisabled();
  await expect(page.locator('.code-node')).toHaveCount(0);
  await setCode(page, simple);
  await expect(page.locator('#runBtn')).toBeEnabled();
});

test('Python file import and download', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles({ name: 'example.py', mimeType: 'text/plain', buffer: Buffer.from(simple) });
  await expect(page.locator('.code-node')).toHaveCount(3);
  const downloadEvent = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('program.py');
  expect(readFileSync(await download.path(), 'utf8')).toBe(simple);
});
