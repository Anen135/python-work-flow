const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const starter = readFileSync('app.js', 'utf8').match(/const STARTER_CODE = `([\s\S]*?)`;/)[1].replace(/\r\n/g, '\n');
const simple = 'x = 1\ny = 2\nprint(x + y)';
const loop = 'total = 0\nfor i in range(4):\n    total += i\nprint(total)';
const input = 'name = input("Name: ")\nprint(name)';
const returns = 'def greet(name):\n    return "Hello, " + name\ndef relay(name):\n    return greet(name)\nmessage = relay("Ada")\nprint(message)';
const fixtures = {};
for (const source of [starter, simple, loop, input, returns, 'broken =', '']) {
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
  await page.evaluate(() => {
    selectGraphNode([...nodeLayout.keys()][1]);
    const before = snapshotLayout();
    moveGraphSelection(before, 45, 80);
    commitLayout(before);
  });
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

test('nested returns send their result from the right port to the actual caller', async ({ page }) => {
  await setCode(page, returns);
  await expect(page.locator('.kind-return .output-port[data-port="Return"]')).toHaveCount(2);
  await page.locator('#clearConsoleBtn').click();
  await page.locator('#speedRange').fill('120');
  await page.locator('#runBtn').click();
  await expect(page.locator('#consoleOutput')).toContainText('Выполнение завершено');
  await expect(page.locator('.console-line').last()).toHaveText('Hello, Ada');
  const connections = await page.evaluate(() => staticEdges.filter(edge => edge.label === 'Return').map(edge => {
    const from = parsed.nodes.find(node => node.id === edge.from);
    const to = parsed.nodes.find(node => node.id === edge.to);
    const sourceNode = nodeElements.get(edge.from);
    const socket = sourceNode.querySelector('.output-port[data-port="Return"] i').getBoundingClientRect();
    const path = edgePaths.get(edge.id);
    const start = path.getPointAtLength(0).matrixTransform(path.getScreenCTM());
    const target = nodeElements.get(edge.to).querySelector('.input-port i').getBoundingClientRect();
    const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM());
    return { from: from.line, to: to.line, kind: edge.kind,
      right: socket.left > sourceNode.getBoundingClientRect().right,
      startError: Math.hypot(start.x - socket.left - socket.width / 2, start.y - socket.top - socket.height / 2),
      endError: Math.hypot(end.x - target.left - target.width / 2, end.y - target.top - target.height / 2) };
  }));
  expect(connections.map(edge => [edge.from, edge.to])).toEqual([[2, 4], [4, 5]]);
  for (const connection of connections) {
    expect(connection.kind).toContain('string');
    expect(connection.right).toBe(true);
    expect(connection.startError).toBeLessThan(.8);
    expect(connection.endError).toBeLessThan(.8);
  }
});

test('horizontal default, legacy layout migration and port-anchored edges at any zoom', async ({ page }) => {
  const boxes = await page.evaluate(() => [...nodeLayout.values()]);
  expect(new Set(boxes.map(b => b.y)).size).toBe(1);
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].x - boxes[i - 1].x - boxes[i - 1].width).toBe(160);

  // Simulate a saved project from the previous default layout.
  await page.evaluate(() => {
    let y = 32;
    for (const node of parsed.nodes) {
      const box = nodeLayout.get(node.id);
      box.x = 42 + node.depth * 350; box.y = y; y += box.height + 54;
    }
    paintLayout(); saveProject();
  });
  await page.reload();
  await expect(page.locator('.code-node')).toHaveCount(13);
  // Version 2 preserves even a deliberately arranged vertical layout.
  expect(await page.evaluate(() => new Set([...nodeLayout.values()].map(b => b.y)).size)).toBeGreaterThan(1);
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem(projectKey));
    delete project.layoutVersion;
    localStorage.setItem(projectKey, JSON.stringify(project));
    window.removeEventListener('pagehide', saveProject);
  });
  await page.reload();
  await expect(page.locator('.code-node')).toHaveCount(13);
  expect(await page.evaluate(() => new Set([...nodeLayout.values()].map(b => b.y)).size)).toBe(1);

  for (const zoom of [1, .5, 1.5]) {
    const measurements = await page.evaluate(zoom => {
      setGraphZoom(zoom);
      const ids = [...nodeLayout.keys()];
      findEdge(ids[0], ids[2], null, true);
      findEdge(ids[0], ids[3], null, true);
      selectGraphNode(ids[1]);
      moveGraphSelection(snapshotLayout(), 15, 25);
      ui.graphScroll.scrollLeft = 140;
      ui.graphScroll.scrollTop = 30;
      drawEdges(staticEdges);
      return staticEdges.map(edge => {
        const path = edgePaths.get(edge.id);
        const output = [...nodeElements.get(edge.from).querySelectorAll('.output-port')].find(p => p.dataset.port === edge.label).querySelector('i');
        const input = nodeElements.get(edge.to).querySelector('.input-port i');
        const start = path.getPointAtLength(0).matrixTransform(path.getScreenCTM());
        const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM());
        const a = output.getBoundingClientRect(), b = input.getBoundingClientRect();
        return { startError: Math.hypot(start.x - a.left - a.width / 2, start.y - a.top - a.height / 2),
          endError: Math.hypot(end.x - b.left - b.width / 2, end.y - b.top - b.height / 2) };
      });
    }, zoom);
    expect(measurements.length).toBeGreaterThan(10);
    for (const measure of measurements) {
      expect(measure.startError).toBeLessThan(.8);
      expect(measure.endError).toBeLessThan(.8);
    }
  }
  await page.locator('#layoutBtn').click();
  const restored = await page.evaluate(() => [...nodeLayout.values()]);
  for (let i = 1; i < restored.length; i++) expect(restored[i].x - restored[i - 1].x - restored[i - 1].width).toBe(160);
});
