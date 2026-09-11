/* Graph interaction and local project tools. No external dependencies. */
let graphZoom = 1;
const graphSelection = new Set();
const layoutUndo = [];
const layoutRedo = [];
const projectKey = 'python-flow-lab.project.v1';
let savedProject = null;
let saveTimer;
try { savedProject = JSON.parse(localStorage.getItem(projectKey)); } catch { /* Storage may be unavailable. */ }

function snapshotLayout() {
  return [...nodeLayout].map(([id, box]) => [id, { x: box.x, y: box.y }]);
}

function paintLayout() {
  nodeLayout.forEach((box, id) => {
    const el = nodeElements.get(id);
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
  });
  updateGraphBounds();
  drawEdges(staticEdges);
}

function restoreLayout(positions) {
  for (const [id, position] of positions) {
    const box = nodeLayout.get(id);
    if (box && Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
      box.x = Math.max(18, Math.min(100000, position.x));
      box.y = Math.max(18, Math.min(100000, position.y));
    }
  }
  paintLayout();
}

function saveProject() {
  clearTimeout(saveTimer);
  try {
    const project = { source: editor.getValue(), positions: snapshotLayout(), layoutVersion: 2 };
    localStorage.setItem(projectKey, JSON.stringify(project));
    $('#saveStatus').textContent = 'Сохранено в браузере';
  } catch { $('#saveStatus').textContent = 'Скачайте код для сохранения'; }
}

function commitLayout(before) {
  if (JSON.stringify(before) === JSON.stringify(snapshotLayout())) return;
  layoutUndo.push(before);
  if (layoutUndo.length > 60) layoutUndo.shift();
  layoutRedo.length = 0;
  updateGraphTools();
  saveProject();
}

function undoLayout(redo = false) {
  const from = redo ? layoutRedo : layoutUndo;
  const to = redo ? layoutUndo : layoutRedo;
  if (!from.length) return;
  to.push(snapshotLayout());
  restoreLayout(from.pop());
  updateGraphTools();
  saveProject();
}

function selectGraphNode(id, additive = false) {
  if (!additive) graphSelection.clear();
  if (additive && graphSelection.has(id)) graphSelection.delete(id);
  else if (nodeElements.has(id)) graphSelection.add(id);
  updateGraphTools();
}

function updateGraphTools() {
  nodeElements.forEach((el, id) => el.classList.toggle('selected-node', graphSelection.has(id)));
  $('#graphSummary').textContent = `${nodeElements.size} нод · выделено ${graphSelection.size}`;
  $('#alignNodes').disabled = graphSelection.size < 2;
  $('#undoLayoutBtn').disabled = !layoutUndo.length;
  $('#redoLayoutBtn').disabled = !layoutRedo.length;
  for (const id of ['layoutBtn', 'fitGraphBtn', 'prevNodeBtn', 'nextNodeBtn', 'activeNodeBtn']) {
    $('#' + id).disabled = !nodeElements.size;
  }
}

function graphRebuilt(previous = new Map()) {
  graphSelection.clear();
  layoutUndo.length = layoutRedo.length = 0;
  if (savedProject?.source === editor.getValue() && Array.isArray(savedProject.positions)) {
    const positions = savedProject.positions.filter(item => Array.isArray(item) && item.length === 2);
    // Migrate only the old automatic column; keep hand-arranged projects intact.
    let oldY = 32;
    const oldPositions = new Map(positions);
    const legacyDefault = !savedProject.layoutVersion && positions.length === nodeLayout.size && (parsed?.nodes ?? []).every(node => {
      const position = oldPositions.get(node.id);
      const matches = position?.x === 42 + node.depth * 350 && position?.y === oldY;
      oldY += nodeLayout.get(node.id).height + 54;
      return matches;
    });
    if (!legacyDefault) restoreLayout(positions);
    savedProject = null;
  } else if (previous.size) restoreLayout([...previous]);
  updateGraphTools();
  searchGraph();
  saveProject();
}

function moveGraphSelection(positions, dx, dy) {
  const selected = positions.filter(([id]) => graphSelection.has(id));
  if (!selected.length) return;
  dx = Math.max(dx, 18 - Math.min(...selected.map(([, p]) => p.x)));
  dy = Math.max(dy, 18 - Math.min(...selected.map(([, p]) => p.y)));
  for (const [id, p] of selected) Object.assign(nodeLayout.get(id), { x: p.x + dx, y: p.y + dy });
  paintLayout();
}

function alignSelection(mode) {
  const boxes = [...graphSelection].map(id => nodeLayout.get(id));
  if (boxes.length < 2) return;
  const before = snapshotLayout();
  const left = Math.min(...boxes.map(b => b.x)), top = Math.min(...boxes.map(b => b.y));
  const right = Math.max(...boxes.map(b => b.x + b.width)), bottom = Math.max(...boxes.map(b => b.y + b.height));
  if (mode === 'horizontal' || mode === 'vertical') {
    const axis = mode === 'horizontal' ? 'x' : 'y';
    const size = axis === 'x' ? 'width' : 'height';
    boxes.sort((a, b) => a[axis] - b[axis]);
    const start = boxes[0][axis];
    const end = boxes.at(-1)[axis] + boxes.at(-1)[size];
    const gap = Math.max(24, (end - start - boxes.reduce((sum, b) => sum + b[size], 0)) / (boxes.length - 1));
    let position = start;
    boxes.forEach(b => { b[axis] = position; position += b[size] + gap; });
  } else boxes.forEach(b => {
    if (mode === 'left') b.x = left;
    if (mode === 'center') b.x = (left + right - b.width) / 2;
    if (mode === 'right') b.x = right - b.width;
    if (mode === 'top') b.y = top;
    if (mode === 'middle') b.y = (top + bottom - b.height) / 2;
    if (mode === 'bottom') b.y = bottom - b.height;
  });
  paintLayout();
  commitLayout(before);
}

function setGraphZoom(value, clientX, clientY) {
  const viewport = ui.graphScroll;
  const rect = viewport.getBoundingClientRect();
  const x = clientX === undefined ? viewport.clientWidth / 2 : clientX - rect.left;
  const y = clientY === undefined ? viewport.clientHeight / 2 : clientY - rect.top;
  const worldX = (viewport.scrollLeft + x) / graphZoom;
  const worldY = (viewport.scrollTop + y) / graphZoom;
  graphZoom = Math.max(.1, Math.min(2, value));
  ui.graphStage.style.zoom = graphZoom;
  viewport.scrollLeft = worldX * graphZoom - x;
  viewport.scrollTop = worldY * graphZoom - y;
  $('#zoomResetBtn').textContent = `${Math.round(graphZoom * 100)}%`;
}

function focusGraphNode(id) {
  const b = nodeLayout.get(id);
  if (!b) return;
  ui.graphScroll.scrollTo({ left: (b.x + b.width / 2) * graphZoom - ui.graphScroll.clientWidth / 2,
    top: (b.y + b.height / 2) * graphZoom - ui.graphScroll.clientHeight / 2, behavior: 'instant' });
}

function fitGraph() {
  if (!nodeLayout.size) return;
  const boxes = [...nodeLayout.values()];
  const width = Math.max(...boxes.map(b => b.x + b.width)) + 60;
  const height = Math.max(...boxes.map(b => b.y + b.height)) + 60;
  setGraphZoom(Math.min(1, ui.graphScroll.clientWidth / width, ui.graphScroll.clientHeight / height));
  ui.graphScroll.scrollTo(0, 0);
}

function searchResults() {
  const query = $('#nodeSearch').value.trim().toLowerCase();
  return (parsed?.nodes ?? []).filter(n => !query || String(n.line) === query || `${n.code} ${n.kind} ${n.scope}`.toLowerCase().includes(query));
}

function searchGraph() {
  const matches = new Set(searchResults().map(n => n.id));
  const searching = Boolean($('#nodeSearch').value.trim());
  nodeElements.forEach((el, id) => {
    el.classList.toggle('search-match', searching && matches.has(id));
    el.classList.toggle('search-muted', searching && !matches.has(id));
  });
  updateGraphTools();
  if (searching) $('#graphSummary').textContent = `Найдено ${matches.size} из ${nodeElements.size} · Enter — перейти`;
}

function navigateGraph(direction) {
  const nodes = searchResults();
  if (!nodes.length) return;
  const current = nodes.findIndex(n => graphSelection.has(n.id));
  const index = current < 0 ? (direction > 0 ? 0 : nodes.length - 1) : (current + direction + nodes.length) % nodes.length;
  const node = nodes[index];
  selectGraphNode(node.id);
  focusGraphNode(node.id);
  editor.gotoLine(node.line, 0, false);
}

function downloadCode() {
  const url = URL.createObjectURL(new Blob([editor.getValue()], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'program.py'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  saveProject();
}

$('#saveFileBtn').addEventListener('click', downloadCode);
$('#openFileBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('Максимальный размер файла — 1 МБ.');
    const source = await file.text();
    editor.setValue(source, -1);
    editor.focus();
  } catch (error) { addConsole(error.message, 'console-error'); }
  event.target.value = '';
});
$('#zoomInBtn').onclick = () => setGraphZoom(graphZoom * 1.2);
$('#zoomOutBtn').onclick = () => setGraphZoom(graphZoom / 1.2);
$('#zoomResetBtn').onclick = () => setGraphZoom(1);
$('#fitGraphBtn').onclick = fitGraph;
$('#prevNodeBtn').onclick = () => navigateGraph(-1);
$('#nextNodeBtn').onclick = () => navigateGraph(1);
$('#activeNodeBtn').onclick = () => focusGraphNode(currentLineEvent?.nodeId);
$('#undoLayoutBtn').onclick = () => undoLayout();
$('#redoLayoutBtn').onclick = () => undoLayout(true);
$('#alignNodes').onchange = event => { alignSelection(event.target.value); event.target.value = ''; };
$('#layoutBtn').onclick = () => {
  const before = snapshotLayout();
  let x = 42;
  for (const node of parsed?.nodes ?? []) {
    const box = nodeLayout.get(node.id);
    box.x = x; box.y = 96;
    x += box.width + 160;
  }
  paintLayout(); commitLayout(before); fitGraph();
};
$('#nodeSearch').addEventListener('input', searchGraph);
$('#nodeSearch').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); navigateGraph(event.shiftKey ? -1 : 1); }
});
ui.graphScroll.addEventListener('wheel', event => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  setGraphZoom(graphZoom * Math.exp(-event.deltaY * .002), event.clientX, event.clientY);
}, { passive: false });

let pan = null;
ui.graphScroll.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.target.closest('.code-node, .flow-edge-hit')) return;
  pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: ui.graphScroll.scrollLeft, top: ui.graphScroll.scrollTop };
  ui.graphScroll.setPointerCapture(event.pointerId);
  ui.graphScroll.classList.add('panning');
  ui.graphScroll.focus({ preventScroll: true });
  event.preventDefault();
});
ui.graphScroll.addEventListener('pointermove', event => {
  if (!pan || pan.id !== event.pointerId) return;
  ui.graphScroll.scrollLeft = pan.left - event.clientX + pan.x;
  ui.graphScroll.scrollTop = pan.top - event.clientY + pan.y;
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) ui.graphScroll.addEventListener(name, event => {
  if (!pan || pan.id !== event.pointerId) return;
  pan = null;
  ui.graphScroll.classList.remove('panning');
  if (ui.graphScroll.hasPointerCapture(event.pointerId)) ui.graphScroll.releasePointerCapture(event.pointerId);
});

document.addEventListener('keydown', event => {
  if (event.isComposing || ui.helpDialog.open) return;
  const mod = event.ctrlKey || event.metaKey;
  const graphFocused = ui.graphScroll.contains(document.activeElement);
  let action = null;
  if (mod && event.code === 'KeyS') action = downloadCode;
  else if (mod && event.code === 'KeyK') action = () => $('#nodeSearch').focus();
  else if (mod && event.key === 'Enter') action = () => (isRunning ? ui.pauseBtn : ui.runBtn).click();
  else if (event.key === 'F10') action = () => (event.shiftKey ? ui.resetBtn : ui.stepBtn).click();
  else if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) action = () => navigateGraph(event.key === 'ArrowUp' ? -1 : 1);
  else if (event.key === 'Escape') action = () => {
    graphSelection.clear(); updateGraphTools(); ui.closeInspector.click();
    $('#nodeSearch').value = ''; searchGraph();
  };
  else if (graphFocused) {
    if (mod && event.code === 'KeyA') action = () => { nodeElements.forEach((_, id) => graphSelection.add(id)); updateGraphTools(); };
    else if (mod && event.code === 'KeyZ') action = () => undoLayout(event.shiftKey);
    else if (!mod && event.code === 'KeyF') action = fitGraph;
    else if (!mod && event.code === 'Digit0') action = () => setGraphZoom(1);
    else if (event.key === 'Enter' && graphSelection.size && !event.target.closest('.code-node')) action = () => openInspector([...graphSelection][0]);
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && graphSelection.size) action = () => {
      const before = snapshotLayout(), step = event.shiftKey ? 100 : 10;
      moveGraphSelection(before, event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
        event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
      commitLayout(before);
    };
  }
  if (action) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) action(); }
}, true);

editor.session.on('change', () => {
  $('#saveStatus').textContent = 'Сохранение…';
  clearTimeout(saveTimer); saveTimer = setTimeout(saveProject, 600);
});
window.addEventListener('pagehide', saveProject);
if (typeof savedProject?.source === 'string') editor.setValue(savedProject.source, -1);
updateGraphTools();
init();
