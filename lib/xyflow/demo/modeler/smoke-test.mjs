#!/usr/bin/env node
/**
 * End-to-end modeler smoke test.
 *
 * Drives every modeling primitive through the public API in puppeteer,
 * then exports XML and re-imports it to confirm the round trip is sane.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = 5195;
const BASE = `http://localhost:${ PORT }`;

const proc = spawn(process.execPath, [ path.join(__dirname, '..', 'serve.mjs') ], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: [ 'ignore', 'pipe', 'inherit' ]
});
proc.stdout.on('data', () => {});

async function waitForServer() {
  for (let i = 0; i < 240; i++) {
    try { const r = await fetch(BASE + '/modeler'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server timeout');
}

let exit = 0;
let browser;
try {
  await waitForServer();
  browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.log('[pageerror]', e.message); });

  await page.goto(BASE + '/modeler', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => /^Loaded/.test(document.getElementById('status')?.textContent || ''), { timeout: 30000 });

  // 1. add a Task via the modeler API
  const addResult = await page.evaluate(() => {
    const m = window.modeler;
    const before = m.getGraph().nodes.length;
    const node = m.addShape('bpmn:Task', { x: 400, y: 150 });
    const after = m.getGraph().nodes.length;
    return { ok: !!node && after === before + 1, addedId: node?.id, type: node?.type };
  });
  console.log(`${ addResult.ok ? 'OK ' : 'FAIL' }  addShape Task  (id=${ addResult.addedId })`);
  if (!addResult.ok) exit = 1;

  // 2. move the new shape and check waypoints stay attached to connected edge
  // (no edge yet; do connect first)
  const connectResult = await page.evaluate(() => {
    const m = window.modeler;
    const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    const task = m.getGraph().nodes.find(n => n.type === 'bpmn:Task');
    if (!start || !task) return { ok: false, reason: 'missing start or task' };
    const beforeEdges = m.getGraph().edges.length;
    m.connect(start, task);
    const afterEdges = m.getGraph().edges.length;
    return { ok: afterEdges === beforeEdges + 1, beforeEdges, afterEdges };
  });
  console.log(`${ connectResult.ok ? 'OK ' : 'FAIL' }  connect Start→Task  (${ connectResult.beforeEdges }→${ connectResult.afterEdges })`);
  if (!connectResult.ok) exit = 1;

  // 3. drag the task: simulate mouse move and verify waypoints rerouted
  //    AND verify the viewport didn't pan (d3-zoom must not steal the gesture)
  const moveResult = await page.evaluate(async () => {
    const m = window.modeler;
    const task = m.getGraph().nodes.find(n => n.type === 'bpmn:Task');
    const taskGfx = document.querySelector(`[data-element-id="${ task.id }"]`);
    const rect = taskGfx.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const startY = rect.top + rect.height / 2;
    const viewportBefore = { ...m.getViewport() };
    const downOpts = { bubbles: true, button: 0, clientX: startX, clientY: startY };
    taskGfx.dispatchEvent(new MouseEvent('mousedown', downOpts));
    await new Promise(r => requestAnimationFrame(r));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: startX + 200, clientY: startY + 80 }));
    await new Promise(r => requestAnimationFrame(r));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: startX + 200, clientY: startY + 80 }));
    await new Promise(r => requestAnimationFrame(r));

    const moved = m.getElement(task.id);
    const edge = m.getGraph().edges[0];
    const lastWp = edge.waypoints[edge.waypoints.length - 1];
    // waypoint should sit on the target shape's boundary (within 1px tolerance)
    const onLeft   = Math.abs(lastWp.x - moved.x) < 1;
    const onRight  = Math.abs(lastWp.x - (moved.x + moved.width)) < 1;
    const onTop    = Math.abs(lastWp.y - moved.y) < 1;
    const onBottom = Math.abs(lastWp.y - (moved.y + moved.height)) < 1;
    const onEdge = onLeft || onRight || onTop || onBottom;
    const viewportAfter = m.getViewport();
    const viewportSame = viewportBefore.x === viewportAfter.x && viewportBefore.y === viewportAfter.y && viewportBefore.zoom === viewportAfter.zoom;
    return {
      ok: onEdge && viewportSame,
      onEdge, viewportSame,
      moved: { x: moved.x, y: moved.y, w: moved.width, h: moved.height },
      lastWp
    };
  });
  console.log(`${ moveResult.ok ? 'OK ' : 'FAIL' }  drag-move reroutes edge + viewport stays  (wp=(${ moveResult.lastWp.x.toFixed(1) },${ moveResult.lastWp.y.toFixed(1) }) onEdge=${ moveResult.onEdge } viewportSame=${ moveResult.viewportSame })`);
  if (!moveResult.ok) exit = 1;

  // 3b. native mouse drag through puppeteer's mouse driver (closest to a
  //     real human drag) — proves d3-zoom doesn't steal the gesture
  await page.evaluate(() => { window.__bpmnDebug = true; });
  page.on('console', m => { if (/\[modeler\]/.test(m.text())) console.log('  ', m.text()); });

  const nativeDrag = await (async () => {
    const before = await page.evaluate(() => {
      const m = window.modeler;
      const task = m.getGraph().nodes.find(n => n.type === 'bpmn:Task');
      const gfx = document.querySelector(`[data-element-id="${ task.id }"]`);
      const r = gfx.getBoundingClientRect();
      return {
        viewport: { ...m.getViewport() },
        nodeStart: { x: task.x, y: task.y },
        clickPoint: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
        id: task.id
      };
    });
    await page.mouse.move(before.clickPoint.x, before.clickPoint.y);
    await page.mouse.down();
    await page.mouse.move(before.clickPoint.x + 60, before.clickPoint.y + 40, { steps: 6 });
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 100));

    const after = await page.evaluate((id) => {
      const m = window.modeler;
      const node = m.getElement(id);
      return { viewport: m.getViewport(), nodePos: { x: node.x, y: node.y } };
    }, before.id);

    const nodeMoved = after.nodePos.x !== before.nodeStart.x || after.nodePos.y !== before.nodeStart.y;
    const viewportStayed = before.viewport.x === after.viewport.x && before.viewport.y === after.viewport.y;
    return { ok: nodeMoved && viewportStayed, nodeMoved, viewportStayed, before, after };
  })();
  console.log(`${ nativeDrag.ok ? 'OK ' : 'FAIL' }  native mouse drag moves node, not pane  (nodeMoved=${ nativeDrag.nodeMoved } viewportStayed=${ nativeDrag.viewportStayed })`);
  if (!nativeDrag.ok) {
    exit = 1;
    console.log('  before:', nativeDrag.before);
    console.log('  after: ', nativeDrag.after);
  }

  // 4. undo the move
  const undoResult = await page.evaluate(() => {
    const m = window.modeler;
    const task = m.getGraph().nodes.find(n => n.type === 'bpmn:Task');
    const before = { x: task.x, y: task.y };
    m.undo();
    const after = { x: m.getElement(task.id).x, y: m.getElement(task.id).y };
    return { ok: before.x !== after.x || before.y !== after.y, before, after };
  });
  console.log(`${ undoResult.ok ? 'OK ' : 'FAIL' }  undo move  (${ undoResult.before.x },${ undoResult.before.y } → ${ undoResult.after.x },${ undoResult.after.y })`);
  if (!undoResult.ok) exit = 1;

  // 5. redo
  const redoResult = await page.evaluate(() => {
    const m = window.modeler;
    const task = m.getGraph().nodes.find(n => n.type === 'bpmn:Task');
    const before = { x: task.x, y: task.y };
    m.redo();
    const after = { x: m.getElement(task.id).x, y: m.getElement(task.id).y };
    return { ok: before.x !== after.x || before.y !== after.y, before, after };
  });
  console.log(`${ redoResult.ok ? 'OK ' : 'FAIL' }  redo move`);
  if (!redoResult.ok) exit = 1;

  // 6. delete the task → should also delete its connected edge
  const deleteResult = await page.evaluate(() => {
    const m = window.modeler;
    const task = m.getGraph().nodes.find(n => n.type === 'bpmn:Task');
    const beforeNodes = m.getGraph().nodes.length;
    const beforeEdges = m.getGraph().edges.length;
    m.delete(task);
    const afterNodes = m.getGraph().nodes.length;
    const afterEdges = m.getGraph().edges.length;
    return {
      ok: afterNodes === beforeNodes - 1 && afterEdges === beforeEdges - 1,
      beforeNodes, afterNodes, beforeEdges, afterEdges
    };
  });
  console.log(`${ deleteResult.ok ? 'OK ' : 'FAIL' }  delete shape removes edges  (nodes ${ deleteResult.beforeNodes }→${ deleteResult.afterNodes }, edges ${ deleteResult.beforeEdges }→${ deleteResult.afterEdges })`);
  if (!deleteResult.ok) exit = 1;

  // 7. inline label rename via API
  const renameResult = await page.evaluate(() => {
    const m = window.modeler;
    const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    start.businessObject.name = ''; // baseline
    // simulate the command stack rename
    m.commandStack.execute({
      name: 'rename',
      do: () => { start.businessObject.name = 'Begin'; },
      undo: () => { start.businessObject.name = ''; }
    });
    const named = start.businessObject.name;
    m.undo();
    const undone = start.businessObject.name;
    return { ok: named === 'Begin' && undone === '', named, undone };
  });
  console.log(`${ renameResult.ok ? 'OK ' : 'FAIL' }  rename round trip  ("${ renameResult.named }" → undone "${ renameResult.undone }")`);
  if (!renameResult.ok) exit = 1;

  // 8. export → re-import round trip
  const xmlResult = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = await m.getXML();
    const beforeNodes = m.getGraph().nodes.length;
    const result = await m.importXML(xml);
    const afterNodes = m.getGraph().nodes.length;
    return {
      ok: !!xml && /<bpmn:definitions/.test(xml) && afterNodes === beforeNodes,
      xmlLen: xml.length,
      beforeNodes, afterNodes,
      warnings: result.warnings.length
    };
  });
  console.log(`${ xmlResult.ok ? 'OK ' : 'FAIL' }  export → re-import round trip  (xml=${ xmlResult.xmlLen }B nodes ${ xmlResult.beforeNodes }→${ xmlResult.afterNodes }, warnings=${ xmlResult.warnings })`);
  if (!xmlResult.ok) exit = 1;

  if (errors.length) {
    console.log('\nPage errors detected:');
    errors.forEach(e => console.log('  ', e));
  }
} catch (e) {
  console.error(e);
  exit = 1;
} finally {
  if (browser) await browser.close();
  proc.kill('SIGTERM');
}

process.exit(exit);
