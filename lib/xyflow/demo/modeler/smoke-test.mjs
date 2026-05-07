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

  // 4. undo the move — node position AND every connected edge waypoint
  //    must return to its exact pre-drag state
  const undoResult = await page.evaluate(() => {
    const m = window.modeler;
    const task = m.getGraph().nodes.find(n => n.type === 'bpmn:Task');
    const before = { x: task.x, y: task.y };
    const beforeEdges = m.getGraph().edges.map(e => ({
      id: e.id,
      waypoints: e.waypoints.map(p => ({ x: p.x, y: p.y }))
    }));
    m.undo();
    const after = { x: m.getElement(task.id).x, y: m.getElement(task.id).y };
    const afterEdges = m.getGraph().edges.map(e => ({
      id: e.id,
      waypoints: e.waypoints.map(p => ({ x: p.x, y: p.y }))
    }));
    const positionChanged = before.x !== after.x || before.y !== after.y;
    const edgesChanged = JSON.stringify(beforeEdges) !== JSON.stringify(afterEdges);
    return { ok: positionChanged && edgesChanged, before, after, beforeEdges, afterEdges };
  });
  console.log(`${ undoResult.ok ? 'OK ' : 'FAIL' }  undo move  (${ undoResult.before.x },${ undoResult.before.y } → ${ undoResult.after.x },${ undoResult.after.y } edges-changed=${ JSON.stringify(undoResult.beforeEdges) !== JSON.stringify(undoResult.afterEdges) })`);
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

  // 5b. drag → undo restores ORIGINAL waypoints; redo restores
  //     POST-DRAG waypoints — bit-exact, no tolerance.
  const moveRoundTrip = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P"><bpmn:startEvent id="S"/></bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    const task = m.addShape('bpmn:Task', { x: 350, y: 100 });
    m.connect(start, task);

    const edge = m.getGraph().edges[0];
    const orig = edge.waypoints.map(p => ({ x: p.x, y: p.y }));

    const gfx = document.querySelector(`[data-element-id="${ task.id }"]`);
    const r = gfx.getBoundingClientRect();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;
    const opts = { bubbles: true, button: 0, clientX: sx, clientY: sy };
    gfx.dispatchEvent(new MouseEvent('mousedown', opts));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: sx + 80, clientY: sy + 50 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: sx + 80, clientY: sy + 50 }));

    const moved = edge.waypoints.map(p => ({ x: p.x, y: p.y }));

    m.undo();
    const undone = edge.waypoints.map(p => ({ x: p.x, y: p.y }));

    m.redo();
    const redone = edge.waypoints.map(p => ({ x: p.x, y: p.y }));

    const undoExact = JSON.stringify(undone) === JSON.stringify(orig);
    const redoExact = JSON.stringify(redone) === JSON.stringify(moved);
    return { ok: undoExact && redoExact, undoExact, redoExact, orig, undone, moved, redone };
  });
  console.log(`${ moveRoundTrip.ok ? 'OK ' : 'FAIL' }  move undo/redo restores edge waypoints exactly  (undo=${ moveRoundTrip.undoExact } redo=${ moveRoundTrip.redoExact })`);
  if (!moveRoundTrip.ok) { exit = 1; console.log(' ', moveRoundTrip); }

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

  // 7b. preserve intermediate waypoints when moving a shape on a
  //     multi-point connection (regression: original behaviour)
  const bendsResult = await page.evaluate(async () => {
    const m = window.modeler;
    const res = await fetch('/test/fixtures/bpmn/draw/conditional-flow.bpmn');
    await m.importXML(await res.text());

    // pick an edge with >2 waypoints, capture middle waypoints, move
    // its source shape, and verify middles are unchanged.
    const edge = m.getGraph().edges.find(e => e.waypoints.length > 2);
    if (!edge) return { ok: false, reason: 'no multi-point edge' };

    const middles = edge.waypoints.slice(1, -1).map(p => ({ x: p.x, y: p.y }));
    const source = edge.source;
    const oldSourceWp = { ...edge.waypoints[0] };

    m.commandStack.execute({
      name: 'test-move',
      do: () => {
        source.x += 30;
        source.y += 20;
        if (source.di && source.di.bounds) {
          source.di.bounds.x = source.x;
          source.di.bounds.y = source.y;
        }
        // delegate to internal setNodePosition path: just call manually
        // by simulating the shift-by-delta on connected edges
      },
      undo: () => {}
    });

    // perform the actual move via the public API path by calling
    // the modeler's setNodePosition equivalent: easiest is to drive
    // through the drag handler. Instead, use addShape's underlying
    // command-driven move helper: mimic by calling internal redrawShape
    // and shiftEdgeEndpoints via the only public knob — drag.
    // Just use the internal: viewer._internals.redrawShape after manual edit.
    // Restore source position cleanly:
    m.undo();

    // Now do it properly through a simulated drag:
    const gfx = document.querySelector(`[data-element-id="${ source.id }"]`);
    const r = gfx.getBoundingClientRect();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;
    const opts = { bubbles: true, button: 0, clientX: sx, clientY: sy };
    gfx.dispatchEvent(new MouseEvent('mousedown', opts));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: sx + 30, clientY: sy + 20 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: sx + 30, clientY: sy + 20 }));

    const after = m.getGraph().edges.find(e => e.id === edge.id);
    const newMiddles = after.waypoints.slice(1, -1).map(p => ({ x: p.x, y: p.y }));
    const middlesPreserved = JSON.stringify(middles) === JSON.stringify(newMiddles);
    const newSourceWp = after.waypoints[0];
    const sourceShifted = newSourceWp.x !== oldSourceWp.x || newSourceWp.y !== oldSourceWp.y;

    return {
      ok: middlesPreserved && sourceShifted,
      middles, newMiddles, oldSourceWp, newSourceWp,
      middlesPreserved, sourceShifted
    };
  });
  console.log(`${ bendsResult.ok ? 'OK ' : 'FAIL' }  multi-point edge preserves bends on move  (middlesPreserved=${ bendsResult.middlesPreserved } sourceShifted=${ bendsResult.sourceShifted })`);
  if (!bendsResult.ok) {
    exit = 1;
    console.log('  middles before:', bendsResult.middles);
    console.log('  middles after: ', bendsResult.newMiddles);
  }

  // 7c. drag a bendpoint to reshape an edge; insert a new bend on
  //     mid-segment click; undo restores original waypoints
  const bendpointResult = await page.evaluate(async () => {
    const m = window.modeler;

    // pick a multi-point edge, select it, then move its middle bendpoint
    const edge = m.getGraph().edges.find(e => e.waypoints.length > 2);
    if (!edge) return { ok: false, reason: 'no multi-point edge' };
    m.select(edge.id);
    await new Promise(r => requestAnimationFrame(r));

    const handles = document.querySelectorAll('.bpmn-xyflow-bendpoint');
    if (!handles.length) return { ok: false, reason: 'no handles rendered' };

    // grab the second handle (a bend) and drag it
    const targetHandle = handles[1];
    const r = targetHandle.getBoundingClientRect();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;
    const wpBefore = { ...edge.waypoints[1] };

    targetHandle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: sx, clientY: sy }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: sx + 50, clientY: sy + 30 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: sx + 50, clientY: sy + 30 }));

    const wpAfter = { ...edge.waypoints[1] };
    const moved = wpAfter.x !== wpBefore.x || wpAfter.y !== wpBefore.y;
    const handlesNow = document.querySelectorAll('.bpmn-xyflow-bendpoint').length;

    // undo restores the waypoint
    m.undo();
    const wpUndone = { ...edge.waypoints[1] };
    const undoOk = wpUndone.x === wpBefore.x && wpUndone.y === wpBefore.y;

    return { ok: moved && handlesNow > 0 && undoOk, wpBefore, wpAfter, wpUndone, moved, undoOk, handlesNow };
  });
  console.log(`${ bendpointResult.ok ? 'OK ' : 'FAIL' }  drag bendpoint reshapes edge + undo  (moved=${ bendpointResult.moved } handles=${ bendpointResult.handlesNow } undoOk=${ bendpointResult.undoOk })`);
  if (!bendpointResult.ok) {
    exit = 1;
    console.log(' ', bendpointResult);
  }

  // 7d. mid-segment click inserts a fresh bendpoint
  const insertResult = await page.evaluate(async () => {
    const m = window.modeler;
    const edge = m.getGraph().edges.find(e => e.waypoints.length === 2);
    if (!edge) {
      // create a fresh 2-point edge
      const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
      const task = m.addShape('bpmn:Task', { x: 700, y: 400 });
      m.connect(start, task);
    }
    const targetEdge = m.getGraph().edges.find(e => e.waypoints.length === 2);
    if (!targetEdge) return { ok: false, reason: 'no 2-point edge' };

    m.select(targetEdge.id);
    await new Promise(r => requestAnimationFrame(r));

    const before = targetEdge.waypoints.length;
    const a = targetEdge.waypoints[0];
    const b = targetEdge.waypoints[1];
    // pick the midpoint of the segment in graph coords, convert to client
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const v = m.getViewport();
    const svgRect = m.getSvg().getBoundingClientRect();
    const clientX = svgRect.left + mid.x * v.zoom + v.x;
    const clientY = svgRect.top  + mid.y * v.zoom + v.y;

    // alt+drag inserts a free-form bendpoint; plain drag now slides
    const target = document.elementFromPoint(clientX, clientY);
    if (!target) return { ok: false, reason: 'no target at midpoint' };

    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, altKey: true, clientX, clientY }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, altKey: true, clientX: clientX + 30, clientY: clientY + 30 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, altKey: true, clientX: clientX + 30, clientY: clientY + 30 }));

    const after = m.getGraph().edges.find(e => e.id === targetEdge.id).waypoints.length;
    return { ok: after === before + 1, before, after };
  });
  console.log(`${ insertResult.ok ? 'OK ' : 'FAIL' }  mid-segment click inserts bendpoint  (${ insertResult.before }→${ insertResult.after })`);
  if (!insertResult.ok) {
    exit = 1;
    console.log(' ', insertResult);
  }

  // 7d2. plain drag on segment slides perpendicular (no insert)
  const segmentSlide = await page.evaluate(async () => {
    const m = window.modeler;
    // ensure we have a 3-waypoint edge
    let edge = m.getGraph().edges.find(e => e.waypoints.length >= 3);
    if (!edge) return { ok: false, reason: 'no 3-pt edge' };
    m.select(edge.id);
    await new Promise(r => requestAnimationFrame(r));

    const before = edge.waypoints.map(p => ({ ...p }));
    const beforeCount = edge.waypoints.length;

    // pick the midpoint of segment 0→1 (first segment)
    const a = edge.waypoints[0], b = edge.waypoints[1];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const v = m.getViewport();
    const svgRect = m.getSvg().getBoundingClientRect();
    const clientX = svgRect.left + mid.x * v.zoom + v.x;
    const clientY = svgRect.top + mid.y * v.zoom + v.y;

    const target = document.elementFromPoint(clientX, clientY);
    if (!target) return { ok: false, reason: 'no target at mid' };

    // plain drag (no alt) → segment slide
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX, clientY }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: clientX + 40, clientY: clientY + 40 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: clientX + 40, clientY: clientY + 40 }));

    const after = edge.waypoints.map(p => ({ ...p }));
    const afterCount = edge.waypoints.length;
    const slid = JSON.stringify(after) !== JSON.stringify(before);
    const noInsert = afterCount === beforeCount;
    return { ok: slid && noInsert, beforeCount, afterCount, slid };
  });
  console.log(`${ segmentSlide.ok ? 'OK ' : 'FAIL' }  plain drag slides segment, no insert  (slid=${ segmentSlide.slid } before=${ segmentSlide.beforeCount } after=${ segmentSlide.afterCount })`);
  if (!segmentSlide.ok) { exit = 1; console.log(' ', segmentSlide); }

  // 7e. double-click an intermediate bendpoint to delete it (and undo)
  const deleteBendResult = await page.evaluate(async () => {
    const m = window.modeler;
    // pick (or build) an edge with 3+ waypoints
    let edge = m.getGraph().edges.find(e => e.waypoints.length >= 3);
    if (!edge) return { ok: false, reason: 'no edge with intermediate waypoint' };

    m.select(edge.id);
    await new Promise(r => requestAnimationFrame(r));

    const handles = document.querySelectorAll('.bpmn-xyflow-bendpoint');
    if (handles.length < 3) return { ok: false, reason: `only ${ handles.length } handles` };

    // double-click the second handle (an intermediate bend)
    const handle = handles[1];
    const r = handle.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const before = edge.waypoints.length;
    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: cx, clientY: cy }));

    const after = edge.waypoints.length;
    m.undo();
    const undone = edge.waypoints.length;

    // attempt to delete an endpoint (should be a no-op)
    const handles2 = document.querySelectorAll('.bpmn-xyflow-bendpoint');
    const endHandle = handles2[0]; // first = source endpoint
    const r2 = endHandle.getBoundingClientRect();
    const beforeEnd = edge.waypoints.length;
    endHandle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r2.left + r2.width / 2, clientY: r2.top + r2.height / 2 }));
    const afterEnd = edge.waypoints.length;

    return {
      ok: after === before - 1 && undone === before && afterEnd === beforeEnd,
      before, after, undone, beforeEnd, afterEnd
    };
  });
  console.log(`${ deleteBendResult.ok ? 'OK ' : 'FAIL' }  dbl-click deletes bendpoint, endpoints protected  (${ deleteBendResult.before }→${ deleteBendResult.after }, undo→${ deleteBendResult.undone }, endpoints ${ deleteBendResult.beforeEnd }→${ deleteBendResult.afterEnd })`);
  if (!deleteBendResult.ok) { exit = 1; console.log(' ', deleteBendResult); }

  // 7f. real native double-click — drives the full mousedown→mouseup→click→
  //     mousedown→mouseup→click→dblclick sequence the browser actually
  //     dispatches. Catches issues where intermediate clicks deselect the
  //     edge and hide the handles before the second click lands.
  const nativeDelete = await (async () => {
    const before = await page.evaluate(async () => {
      const m = window.modeler;
      // fresh scenario: empty diagram + 2 shapes + connection + insert a bend
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="173" y="102" width="36" height="36"/>
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
      await m.importXML(xml);
      const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
      const task = m.addShape('bpmn:Task', { x: 400, y: 100 });
      m.connect(start, task);
      const edge = m.getGraph().edges[0];
      // insert a bend programmatically by selecting and using the API path
      m.select(edge.id);
      // splice in a bend at midpoint
      const a = edge.waypoints[0];
      const b = edge.waypoints[1];
      edge.waypoints = [ a, { x: (a.x + b.x) / 2 + 30, y: (a.y + b.y) / 2 - 30 }, b ];
      m.viewer._internals.redrawConnection(edge);
      m.select(edge.id); // re-select to render handles
      await new Promise(r => requestAnimationFrame(r));
      return { edgeId: edge.id, waypointCount: edge.waypoints.length };
    });

    // locate the middle handle in client coords
    const handlePos = await page.evaluate(() => {
      const handles = document.querySelectorAll('.bpmn-xyflow-bendpoint');
      const h = handles[1];
      if (!h) return null;
      const r = h.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (!handlePos) return { ok: false, reason: 'no middle handle' };

    // do a real native double-click
    await page.mouse.move(handlePos.x, handlePos.y);
    await page.mouse.click(handlePos.x, handlePos.y, { count: 2, delay: 50 });
    await new Promise(r => setTimeout(r, 200));

    const after = await page.evaluate((edgeId) => {
      const m = window.modeler;
      const edge = m.getGraph().edges.find(e => e.id === edgeId);
      const handles = document.querySelectorAll('.bpmn-xyflow-bendpoint').length;
      return { waypointCount: edge.waypoints.length, handles };
    }, before.edgeId);

    return {
      ok: after.waypointCount === before.waypointCount - 1,
      before, after
    };
  })();
  console.log(`${ nativeDelete.ok ? 'OK ' : 'FAIL' }  native dbl-click deletes bendpoint  (waypoints ${ nativeDelete.before.waypointCount }→${ nativeDelete.after.waypointCount })`);
  if (!nativeDelete.ok) { exit = 1; console.log(' ', nativeDelete); }

  // restore the simple test diagram for the export round-trip step
  await page.evaluate(async () => {
    const m = window.modeler;
    // empty model
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="173" y="102" width="36" height="36"/>
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
  });

  // 7g. resize a node → connected edge's anchor stays at the same
  //     relative position on the boundary (no visual jump)
  const resizeAnchor = await page.evaluate(async () => {
    const m = window.modeler;
    // empty diagram + Start → Task; resize the Task by SE corner
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:startEvent id="S"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="d">
    <bpmndi:BPMNPlane id="p" bpmnElement="P">
      <bpmndi:BPMNShape id="S_di" bpmnElement="S"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    const task = m.addShape('bpmn:Task', { x: 350, y: 100 });
    m.connect(start, task);

    const edge = m.getGraph().edges[0];
    const beforeWp = { ...edge.waypoints[edge.waypoints.length - 1] };

    // relative position of target anchor on old task bounds
    const oldRx = (beforeWp.x - task.x) / task.width;
    const oldRy = (beforeWp.y - task.y) / task.height;

    // resize the task by 40 wider, 30 taller (SE direction: x,y unchanged)
    const newW = task.width + 40;
    const newH = task.height + 30;
    m.viewer._internals && (() => {})();
    // call the public resize via the internal applyResize through the
    // resize handle path: simulate a SE drag programmatically
    // simpler: call the modeler's command stack with the same intent
    // — use applyResize through the smoke test by directly tweaking and
    // letting the modeler run its routine via the resize-handle path
    const t = m.getElement(task.id);
    const oldBounds = { x: t.x, y: t.y, w: t.width, h: t.height };
    t.x = oldBounds.x; t.y = oldBounds.y;
    // can't call private applyResize from outside; trigger via mouse drag on SE handle
    m.select(task.id);
    await new Promise(r => requestAnimationFrame(r));
    const seHandle = document.querySelector('[data-resize-dir="se"]');
    if (!seHandle) return { ok: false, reason: 'no se handle' };
    const r = seHandle.getBoundingClientRect();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;
    const v = m.getViewport();
    seHandle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: sx, clientY: sy }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: sx + 40 * v.zoom, clientY: sy + 30 * v.zoom }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: sx + 40 * v.zoom, clientY: sy + 30 * v.zoom }));
    await new Promise(r => requestAnimationFrame(r));

    const after = m.getElement(task.id);
    const afterEdge = m.getGraph().edges[0];
    const afterWp = afterEdge.waypoints[afterEdge.waypoints.length - 1];
    const newRx = (afterWp.x - after.x) / after.width;
    const newRy = (afterWp.y - after.y) / after.height;

    return {
      ok: Math.abs(newRx - oldRx) < 0.05 && Math.abs(newRy - oldRy) < 0.05,
      oldRel: { rx: oldRx, ry: oldRy },
      newRel: { rx: newRx, ry: newRy },
      sizeChanged: after.width !== oldBounds.w || after.height !== oldBounds.h
    };
  });
  console.log(`${ resizeAnchor.ok && resizeAnchor.sizeChanged ? 'OK ' : 'FAIL' }  resize keeps edge anchor at same relative position  (rel ${ JSON.stringify(resizeAnchor.oldRel) } → ${ JSON.stringify(resizeAnchor.newRel) })`);
  if (!resizeAnchor.ok || !resizeAnchor.sizeChanged) { exit = 1; console.log(' ', resizeAnchor); }

  // 7g2. resize out then back to ORIGINAL size — anchor must return to
  //      its original coordinates exactly (no floating-point drift)
  const resizeRoundTrip = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P"><bpmn:startEvent id="S"/></bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    // Place the task somewhere whose edges aren't within snap-threshold
    // of the start event's edges, otherwise neighbour-snap (correctly)
    // pulls a resize-back toward alignment and the bit-exact assertion
    // would be violated.
    const task = m.addShape('bpmn:Task', { x: 600, y: 400 });
    m.connect(start, task);

    const edge = m.getGraph().edges[0];
    const origWp = { ...edge.waypoints[edge.waypoints.length - 1] };
    const origBounds = { x: task.x, y: task.y, w: task.width, h: task.height };

    function dragSouth(deltaY) {
      m.select(task.id);
      // need a fresh frame so handles are rendered
      const sHandle = document.querySelector('[data-resize-dir="s"]');
      const r = sHandle.getBoundingClientRect();
      const sx = r.left + r.width / 2;
      const sy = r.top + r.height / 2;
      const v = m.getViewport();
      sHandle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: sx, clientY: sy }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: sx, clientY: sy + deltaY * v.zoom }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: sx, clientY: sy + deltaY * v.zoom }));
    }

    // grow taller, then shrink back to the same height
    dragSouth(50);
    await new Promise(r => requestAnimationFrame(r));
    dragSouth(-50);
    await new Promise(r => requestAnimationFrame(r));

    const after = m.getElement(task.id);
    const finalEdge = m.getGraph().edges.find(e => e.id === edge.id);
    const finalWp = finalEdge.waypoints[finalEdge.waypoints.length - 1];
    const sameSize = after.width === origBounds.w && after.height === origBounds.h;
    const sameWp = finalWp.x === origWp.x && finalWp.y === origWp.y;

    return { ok: sameSize && sameWp, sameSize, sameWp, origWp, finalWp,
             origBounds, finalBounds: { w: after.width, h: after.height } };
  });
  console.log(`${ resizeRoundTrip.ok ? 'OK ' : 'FAIL' }  resize out & back: anchor returns exactly  (orig=${ JSON.stringify(resizeRoundTrip.origWp) } final=${ JSON.stringify(resizeRoundTrip.finalWp) })`);
  if (!resizeRoundTrip.ok) { exit = 1; console.log(' ', resizeRoundTrip); }

  // 7h. modeling rules: connect should refuse EndEvent → StartEvent
  const rulesResult = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:startEvent id="S"/>
    <bpmn:endEvent id="E"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="E_di" bpmnElement="E"><dc:Bounds x="400" y="100" width="36" height="36"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    const end = m.getGraph().nodes.find(n => n.type === 'bpmn:EndEvent');
    const before = m.getGraph().edges.length;
    const reverse = m.connect(end, start);   // invalid: end → start
    const reverseEdges = m.getGraph().edges.length;
    const forward = m.connect(start, end);   // valid
    const forwardEdges = m.getGraph().edges.length;
    return {
      ok: reverse === null && reverseEdges === before && forward && forwardEdges === before + 1,
      reverse, reverseEdges, forwardEdges, type: forward && forward.type
    };
  });
  console.log(`${ rulesResult.ok ? 'OK ' : 'FAIL' }  rules reject End→Start, accept Start→End  (forward.type=${ rulesResult.type })`);
  if (!rulesResult.ok) { exit = 1; console.log(' ', rulesResult); }

  // 7i. reconnect — drag the edge's source endpoint onto a different shape
  const reconnectResult = await page.evaluate(async () => {
    const m = window.modeler;
    // diagram already has Start, End and one edge from previous step
    const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    const end = m.getGraph().nodes.find(n => n.type === 'bpmn:EndEvent');
    const task = m.addShape('bpmn:Task', { x: 250, y: 100 });
    const edge = m.getGraph().edges[0];

    m.select(edge.id);
    await new Promise(r => requestAnimationFrame(r));
    const handles = document.querySelectorAll('.bpmn-xyflow-bendpoint');
    if (!handles.length) return { ok: false, reason: 'no handles' };
    const sourceHandle = handles[0]; // index 0 = source endpoint
    const r = sourceHandle.getBoundingClientRect();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;

    // drop onto the task
    const taskGfx = document.querySelector(`[data-element-id="${ task.id }"]`);
    const tr = taskGfx.getBoundingClientRect();
    const tx = tr.left + tr.width / 2;
    const ty = tr.top + tr.height / 2;

    sourceHandle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: sx, clientY: sy }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: tx, clientY: ty }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: tx, clientY: ty }));

    const updated = m.getGraph().edges.find(e => e.id === edge.id);
    return { ok: updated.source === task, sourceId: updated.source.id, expectedId: task.id };
  });
  console.log(`${ reconnectResult.ok ? 'OK ' : 'FAIL' }  drag endpoint reconnects edge to new shape`);
  if (!reconnectResult.ok) { exit = 1; console.log(' ', reconnectResult); }

  // 7j. event-definition swap via replace
  const eventDefResult = await page.evaluate(async () => {
    const m = window.modeler;
    const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    m.replace(start, 'bpmn:StartEvent', { __eventDefinition: 'bpmn:MessageEventDefinition' });
    const defs = start.businessObject.eventDefinitions;
    return { ok: Array.isArray(defs) && defs.length === 1 && defs[0].$type === 'bpmn:MessageEventDefinition' };
  });
  console.log(`${ eventDefResult.ok ? 'OK ' : 'FAIL' }  replace adds MessageEventDefinition to start event`);
  if (!eventDefResult.ok) { exit = 1; console.log(' ', eventDefResult); }

  // 7k. activity marker toggle
  const markerResult = await page.evaluate(() => {
    const m = window.modeler;
    const task = m.getGraph().nodes.find(n => n.type === 'bpmn:Task');
    if (!task) return { ok: false, reason: 'no task' };
    m.toggleMarker(task, 'loop');
    const isLoop = task.businessObject.loopCharacteristics &&
                   task.businessObject.loopCharacteristics.$type === 'bpmn:StandardLoopCharacteristics';
    m.undo();
    const reverted = !task.businessObject.loopCharacteristics;
    return { ok: isLoop && reverted, isLoop, reverted };
  });
  console.log(`${ markerResult.ok ? 'OK ' : 'FAIL' }  toggleMarker(loop) → undo round trip`);
  if (!markerResult.ok) { exit = 1; console.log(' ', markerResult); }

  // 7l. external label DI created on add for an event-type shape
  const labelDiResult = await page.evaluate(() => {
    const m = window.modeler;
    const ev = m.addShape('bpmn:EndEvent', { x: 600, y: 200 });
    const hasLabelDi = ev.di && ev.di.label && ev.di.label.bounds;
    return { ok: !!hasLabelDi, has: !!hasLabelDi };
  });
  console.log(`${ labelDiResult.ok ? 'OK ' : 'FAIL' }  new event has BPMNLabel DI entry`);
  if (!labelDiResult.ok) { exit = 1; console.log(' ', labelDiResult); }

  // 7m. drag the connection-label to a custom position and check
  //     that di.label.bounds reflects the new coords
  const labelDrag = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:startEvent id="S"/>
    <bpmn:task id="T" name="Step"/>
    <bpmn:sequenceFlow id="F" sourceRef="S" targetRef="T" name="ok"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="T_di" bpmnElement="T"><dc:Bounds x="300" y="80" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="F_di" bpmnElement="F">
      <di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="136" y="118"/>
      <di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="300" y="120"/>
    </bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    await new Promise(r => requestAnimationFrame(r));
    const label = document.querySelector('[data-connection-label="true"]');
    if (!label) return { ok: false, reason: 'no label rendered' };
    const r = label.getBoundingClientRect();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;
    label.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: sx, clientY: sy }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: sx + 30, clientY: sy + 25 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: sx + 30, clientY: sy + 25 }));
    const edge = m.getGraph().edges[0];
    const persisted = edge.di && edge.di.label && edge.di.label.bounds;
    return { ok: !!persisted, hasBounds: !!persisted };
  });
  console.log(`${ labelDrag.ok ? 'OK ' : 'FAIL' }  drag connection label persists to di.label.bounds`);
  if (!labelDrag.ok) { exit = 1; console.log(' ', labelDrag); }

  // 7n. select-all picks up every visible element
  const selectAllResult = await page.evaluate(() => {
    const m = window.modeler;
    const totalShapes = m.getGraph().nodes.filter(n => !n.hidden && n.type !== 'label' && 'x' in n).length;
    const totalEdges  = m.getGraph().edges.filter(e => !e.hidden).length;
    const svg = m.getSvg();
    svg.focus();
    svg.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', ctrlKey: true }));
    const sel = m.getSelection();
    return { ok: sel.length === totalShapes + totalEdges, total: totalShapes + totalEdges, selected: sel.length };
  });
  console.log(`${ selectAllResult.ok ? 'OK ' : 'FAIL' }  Ctrl+A selects every visible element  (${ selectAllResult.selected }/${ selectAllResult.total })`);
  if (!selectAllResult.ok) { exit = 1; console.log(' ', selectAllResult); }

  // 7o. selection marker rect appears around a selected shape
  const selMarkerResult = await page.evaluate(() => {
    const m = window.modeler;
    m.clearSelection();
    const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    m.select(start.id);
    const markerCount = document.querySelectorAll('.bpmn-xyflow-selection-markers rect').length;
    return { ok: markerCount === 1, markerCount };
  });
  console.log(`${ selMarkerResult.ok ? 'OK ' : 'FAIL' }  selection marker rect drawn  (${ selMarkerResult.markerCount })`);
  if (!selMarkerResult.ok) { exit = 1; console.log(' ', selMarkerResult); }

  // 7p. delete-edge prunes incoming/outgoing
  const edgeDeletePrune = await page.evaluate(() => {
    const m = window.modeler;
    const edge = m.getGraph().edges[0];
    const src = edge.source.businessObject;
    const tgt = edge.target.businessObject;
    const beforeOut = (src.outgoing || []).length;
    const beforeIn  = (tgt.incoming || []).length;
    m.delete(edge);
    const afterOut = (src.outgoing || []).length;
    const afterIn  = (tgt.incoming || []).length;
    return {
      ok: afterOut === beforeOut - 1 && afterIn === beforeIn - 1,
      beforeOut, afterOut, beforeIn, afterIn
    };
  });
  console.log(`${ edgeDeletePrune.ok ? 'OK ' : 'FAIL' }  delete edge prunes outgoing/incoming  (out ${ edgeDeletePrune.beforeOut }→${ edgeDeletePrune.afterOut }, in ${ edgeDeletePrune.beforeIn }→${ edgeDeletePrune.afterIn })`);
  if (!edgeDeletePrune.ok) { exit = 1; console.log(' ', edgeDeletePrune); }

  // 7q. copy / paste of a shape + connection
  const cpEdges = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:startEvent id="S"/>
    <bpmn:task id="T"/>
    <bpmn:sequenceFlow id="F" sourceRef="S" targetRef="T"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="T_di" bpmnElement="T"><dc:Bounds x="300" y="80" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="F_di" bpmnElement="F">
      <di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="136" y="118"/>
      <di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="300" y="120"/>
    </bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    const task = m.getGraph().nodes.find(n => n.type === 'bpmn:Task');
    m.select([ start.id, task.id ]);
    const edgesBefore = m.getGraph().edges.length;
    const shapesBefore = m.getGraph().nodes.length;
    // simulate Ctrl+C / Ctrl+V via the public methods
    document.body.focus();
    const svg = m.getSvg();
    svg.focus();
    svg.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'c', ctrlKey: true }));
    svg.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'v', ctrlKey: true }));
    return {
      ok: m.getGraph().nodes.length === shapesBefore + 2 && m.getGraph().edges.length === edgesBefore + 1,
      shapesBefore, shapesAfter: m.getGraph().nodes.length,
      edgesBefore, edgesAfter: m.getGraph().edges.length
    };
  });
  console.log(`${ cpEdges.ok ? 'OK ' : 'FAIL' }  copy/paste includes connection  (shapes ${ cpEdges.shapesBefore }→${ cpEdges.shapesAfter }, edges ${ cpEdges.edgesBefore }→${ cpEdges.edgesAfter })`);
  if (!cpEdges.ok) { exit = 1; console.log(' ', cpEdges); }

  // 7r. collapsed sub-process hides children
  const collapseResult = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:subProcess id="SP">
      <bpmn:startEvent id="IS"/>
      <bpmn:task id="IT"/>
    </bpmn:subProcess>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="SP_di" bpmnElement="SP" isExpanded="true">
      <dc:Bounds x="50" y="50" width="400" height="200"/>
    </bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="IS_di" bpmnElement="IS"><dc:Bounds x="100" y="120" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="IT_di" bpmnElement="IT"><dc:Bounds x="200" y="100" width="100" height="80"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    await new Promise(r => requestAnimationFrame(r));
    const sp = m.getGraph().nodes.find(n => n.type === 'bpmn:SubProcess');
    const beforeVisible = document.querySelectorAll('[data-element-id="IS"], [data-element-id="IT"]').length;
    m.toggleExpanded(sp);
    await new Promise(r => requestAnimationFrame(r));
    const afterVisible = document.querySelectorAll('[data-element-id="IS"], [data-element-id="IT"]').length;
    return { ok: beforeVisible === 2 && afterVisible === 0, beforeVisible, afterVisible };
  });
  console.log(`${ collapseResult.ok ? 'OK ' : 'FAIL' }  collapse hides sub-process children  (visible ${ collapseResult.beforeVisible }→${ collapseResult.afterVisible })`);
  if (!collapseResult.ok) { exit = 1; console.log(' ', collapseResult); }

  // 7s. selected edge gets a marker rect drawn around its waypoints
  const edgeMarker = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:startEvent id="S"/><bpmn:task id="T"/>
    <bpmn:sequenceFlow id="F" sourceRef="S" targetRef="T"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="T_di" bpmnElement="T"><dc:Bounds x="300" y="80" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="F_di" bpmnElement="F">
      <di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="136" y="118"/>
      <di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="300" y="120"/>
    </bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const edge = m.getGraph().edges[0];
    if (!edge) return { ok: false, reason: 'no edge' };
    m.clearSelection();
    m.select(edge.id);
    const rectCount = document.querySelectorAll('.bpmn-xyflow-selection-markers rect').length;
    return { ok: rectCount === 1, rectCount };
  });
  console.log(`${ edgeMarker.ok ? 'OK ' : 'FAIL' }  selected edge has a marker rect  (${ edgeMarker.rectCount })`);
  if (!edgeMarker.ok) { exit = 1; console.log(' ', edgeMarker); }

  // 7t. minimap refreshes after addShape
  const minimapLive = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P"><bpmn:startEvent id="S"/></bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const before = document.querySelectorAll('.bpmn-xyflow-minimap rect').length;
    m.addShape('bpmn:Task', { x: 600, y: 400 });
    await new Promise(r => requestAnimationFrame(r));
    const after = document.querySelectorAll('.bpmn-xyflow-minimap rect').length;
    return { ok: after > before, before, after };
  });
  console.log(`${ minimapLive.ok ? 'OK ' : 'FAIL' }  minimap rect count grows on addShape  (${ minimapLive.before }→${ minimapLive.after })`);
  if (!minimapLive.ok) { exit = 1; console.log(' ', minimapLive); }

  // 7u. label editor font scales with viewport zoom
  const editorZoom = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P"><bpmn:startEvent id="S"/></bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    m.setViewport({ x: 0, y: 0, zoom: 2 });
    const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    // open the editor by directly invoking the dblclick path
    const gfx = document.querySelector(`[data-element-id="${ start.id }"]`);
    const r = gfx.getBoundingClientRect();
    gfx.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    await new Promise(r => requestAnimationFrame(r));
    const editor = document.querySelector('[contenteditable="true"]');
    if (!editor) return { ok: false, reason: 'no editor' };
    const fontSize = parseFloat(getComputedStyle(editor).fontSize);
    editor.blur();
    return { ok: Math.abs(fontSize - 24) < 1, fontSize }; // 12 * zoom 2 = 24
  });
  console.log(`${ editorZoom.ok ? 'OK ' : 'FAIL' }  label editor font scales with zoom  (${ editorZoom.fontSize }px @ zoom=2)`);
  if (!editorZoom.ok) { exit = 1; console.log(' ', editorZoom); }

  // 7v. Escape during drag aborts and restores
  const escCancel = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P"><bpmn:startEvent id="S"/></bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    m.setViewport({ x: 0, y: 0, zoom: 1 });
    const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    const orig = { x: start.x, y: start.y };
    const gfx = document.querySelector(`[data-element-id="${ start.id }"]`);
    const r = gfx.getBoundingClientRect();
    const sx = r.left + r.width / 2, sy = r.top + r.height / 2;
    gfx.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: sx, clientY: sy }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: sx + 80, clientY: sy + 50 }));
    // Esc mid-drag
    const svg = m.getSvg();
    svg.focus();
    svg.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    // mouseup is now a no-op (drag was cancelled)
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: sx + 80, clientY: sy + 50 }));
    const after = m.getElement(start.id);
    return { ok: after.x === orig.x && after.y === orig.y, orig, after: { x: after.x, y: after.y } };
  });
  console.log(`${ escCancel.ok ? 'OK ' : 'FAIL' }  Escape mid-drag restores position  (${ JSON.stringify(escCancel.orig) } → ${ JSON.stringify(escCancel.after) })`);
  if (!escCancel.ok) { exit = 1; console.log(' ', escCancel); }

  // 7w. paste increments offset between repeated pastes
  const pasteIncr = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P"><bpmn:task id="T"/></bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="T_di" bpmnElement="T"><dc:Bounds x="100" y="100" width="100" height="80"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const t = m.getGraph().nodes.find(n => n.type === 'bpmn:Task');
    m.select(t.id);
    const svg = m.getSvg();
    svg.focus();
    svg.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'c', ctrlKey: true }));
    svg.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'v', ctrlKey: true }));
    const after1 = m.getGraph().nodes.find(n => n.id !== t.id && n.type === 'bpmn:Task');
    svg.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'v', ctrlKey: true }));
    const tasks = m.getGraph().nodes.filter(n => n.type === 'bpmn:Task' && n.id !== t.id);
    if (tasks.length < 2) return { ok: false, count: tasks.length };
    const dx = Math.abs(tasks[0].x - tasks[1].x);
    const dy = Math.abs(tasks[0].y - tasks[1].y);
    return { ok: dx > 0 || dy > 0, dx, dy };
  });
  console.log(`${ pasteIncr.ok ? 'OK ' : 'FAIL' }  repeated paste produces an offset  (Δx=${ pasteIncr.dx } Δy=${ pasteIncr.dy })`);
  if (!pasteIncr.ok) { exit = 1; console.log(' ', pasteIncr); }

  // 7x. external label DI bounds translate with host on move
  const labelFollows = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P"><bpmn:startEvent id="S" name="Begin"/></bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S">
      <dc:Bounds x="100" y="100" width="36" height="36"/>
      <bpmndi:BPMNLabel><dc:Bounds x="80" y="140" width="80" height="20"/></bpmndi:BPMNLabel>
    </bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    const lb0 = start.di.label && start.di.label.bounds;
    if (!lb0) return { ok: false, reason: 'no label di' };
    const before = { x: lb0.x, y: lb0.y };
    // move start by an exact amount via the public API path
    const gfx = document.querySelector(`[data-element-id="${ start.id }"]`);
    const r = gfx.getBoundingClientRect();
    const sx = r.left + r.width / 2, sy = r.top + r.height / 2;
    gfx.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: sx, clientY: sy }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: sx + 50, clientY: sy + 30 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: sx + 50, clientY: sy + 30 }));
    const after = { x: start.di.label.bounds.x, y: start.di.label.bounds.y };
    return {
      ok: after.x !== before.x && after.y !== before.y,
      before, after,
      moved: { dx: after.x - before.x, dy: after.y - before.y }
    };
  });
  console.log(`${ labelFollows.ok ? 'OK ' : 'FAIL' }  external label DI follows host on move  (Δ${ JSON.stringify(labelFollows.moved) })`);
  if (!labelFollows.ok) { exit = 1; console.log(' ', labelFollows); }

  // 7y. delete strips the element from selection (and its overlays)
  const deleteDeselect = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P"><bpmn:task id="T"/></bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="T_di" bpmnElement="T"><dc:Bounds x="100" y="100" width="100" height="80"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const t = m.getGraph().nodes.find(n => n.type === 'bpmn:Task');
    m.select(t.id);
    await new Promise(r => requestAnimationFrame(r));
    const beforeSel = m.getSelection().length;
    const beforeMarker = document.querySelectorAll('.bpmn-xyflow-selection-markers rect').length;
    const beforeResize = document.querySelectorAll('.bpmn-xyflow-resize-handle').length;
    const beforePad = document.querySelector('.bpmn-xyflow-context-pad') ? 1 : 0;

    m.delete(t);   // deleteElement is exposed as `delete`
    await new Promise(r => requestAnimationFrame(r));

    const afterSel = m.getSelection().length;
    const afterMarker = document.querySelectorAll('.bpmn-xyflow-selection-markers rect').length;
    const afterResize = document.querySelectorAll('.bpmn-xyflow-resize-handle').length;
    const afterPad = document.querySelector('.bpmn-xyflow-context-pad') ? 1 : 0;

    return {
      ok: beforeSel === 1 && afterSel === 0 &&
          beforeMarker === 1 && afterMarker === 0 &&
          beforeResize === 8 && afterResize === 0 &&
          beforePad === 1 && afterPad === 0,
      beforeSel, afterSel,
      beforeMarker, afterMarker,
      beforeResize, afterResize,
      beforePad, afterPad
    };
  });
  console.log(`${ deleteDeselect.ok ? 'OK ' : 'FAIL' }  delete strips selection + overlays  (sel ${ deleteDeselect.beforeSel }→${ deleteDeselect.afterSel }, marker ${ deleteDeselect.beforeMarker }→${ deleteDeselect.afterMarker }, resize ${ deleteDeselect.beforeResize }→${ deleteDeselect.afterResize }, pad ${ deleteDeselect.beforePad }→${ deleteDeselect.afterPad })`);
  if (!deleteDeselect.ok) { exit = 1; console.log(' ', deleteDeselect); }

  // 7z. connect handle is dismissed when a drag, resize, or bend gesture starts
  const connectHandleDismiss = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P"><bpmn:task id="T"/></bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="T_di" bpmnElement="T"><dc:Bounds x="200" y="200" width="100" height="80"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const t = m.getGraph().nodes.find(n => n.type === 'bpmn:Task');
    const gfx = document.querySelector(`[data-element-id="${ t.id }"]`);
    const r = gfx.getBoundingClientRect();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;
    // hover to show the connect handle, simulated by directly invoking
    // the public viewer hover event
    m.viewer.on; // touch — no-op
    // Real flow: viewer fires element.hover via pointermove. Use mousemove
    // on the shape which the viewer's pointer-tracking turns into hover.
    gfx.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: sx, clientY: sy }));
    await new Promise(r => setTimeout(r, 50));
    const beforeHandles = document.querySelectorAll('.bpmn-xyflow-connect-handle').length;

    // start a shape drag → handle should disappear
    gfx.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: sx, clientY: sy }));
    const afterMousedown = document.querySelectorAll('.bpmn-xyflow-connect-handle').length;
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: sx, clientY: sy }));

    return { ok: beforeHandles >= 1 && afterMousedown === 0, beforeHandles, afterMousedown };
  });
  console.log(`${ connectHandleDismiss.ok ? 'OK ' : 'FAIL' }  connect handle dismissed at drag start  (${ connectHandleDismiss.beforeHandles }→${ connectHandleDismiss.afterMousedown })`);
  if (!connectHandleDismiss.ok) { exit = 1; console.log(' ', connectHandleDismiss); }

  // 7aa. selection markers refresh on resize so the dashed rect
  //      stays around the new bounds
  const markerOnResize = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P"><bpmn:task id="T"/></bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="T_di" bpmnElement="T"><dc:Bounds x="200" y="200" width="100" height="80"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const t = m.getGraph().nodes.find(n => n.type === 'bpmn:Task');
    m.select(t.id);
    await new Promise(r => requestAnimationFrame(r));
    const seHandle = document.querySelector('[data-resize-dir="se"]');
    const r = seHandle.getBoundingClientRect();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;
    const v = m.getViewport();
    seHandle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: sx, clientY: sy }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: sx + 60 * v.zoom, clientY: sy + 40 * v.zoom }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: sx + 60 * v.zoom, clientY: sy + 40 * v.zoom }));

    // Read the marker rect's geometry — it should bracket the new bounds
    const markerRect = document.querySelector('.bpmn-xyflow-selection-markers rect');
    if (!markerRect) return { ok: false, reason: 'no marker rect' };
    const mw = parseFloat(markerRect.getAttribute('width'));
    const mh = parseFloat(markerRect.getAttribute('height'));
    // expected width = newWidth + 2*PAD (12), height = newHeight + 2*PAD
    return {
      ok: Math.abs(mw - (t.width + 12)) < 1 && Math.abs(mh - (t.height + 12)) < 1,
      mw, mh, w: t.width, h: t.height
    };
  });
  console.log(`${ markerOnResize.ok ? 'OK ' : 'FAIL' }  selection marker tracks resized bounds  (rect ${ markerOnResize.mw }×${ markerOnResize.mh } shape ${ markerOnResize.w }×${ markerOnResize.h })`);
  if (!markerOnResize.ok) { exit = 1; console.log(' ', markerOnResize); }

  // 7bb. external label graph node follows the host on shape move
  const labelNodeFollows = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P"><bpmn:startEvent id="S" name="Begin"/></bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S">
      <dc:Bounds x="200" y="200" width="36" height="36"/>
      <bpmndi:BPMNLabel><dc:Bounds x="180" y="240" width="80" height="20"/></bpmndi:BPMNLabel>
    </bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    const labelNode = start.label;
    if (!labelNode) return { ok: false, reason: 'no label node' };
    const beforeLabel = { x: labelNode.x, y: labelNode.y };
    const beforeGfxXform = (() => {
      const g = document.querySelector(`[data-element-id="${ labelNode.id }"]`);
      return g && g.getAttribute('transform');
    })();

    // drag the start event by exact graph delta
    const gfx = document.querySelector(`[data-element-id="${ start.id }"]`);
    const r = gfx.getBoundingClientRect();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;
    const v = m.getViewport();
    gfx.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: sx, clientY: sy }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: sx + 50 * v.zoom, clientY: sy + 30 * v.zoom }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: sx + 50 * v.zoom, clientY: sy + 30 * v.zoom }));

    const afterLabel = { x: labelNode.x, y: labelNode.y };
    const afterGfxXform = (() => {
      const g = document.querySelector(`[data-element-id="${ labelNode.id }"]`);
      return g && g.getAttribute('transform');
    })();

    return {
      ok: afterLabel.x !== beforeLabel.x && afterLabel.y !== beforeLabel.y &&
          afterGfxXform !== beforeGfxXform,
      beforeLabel, afterLabel, beforeGfxXform, afterGfxXform
    };
  });
  console.log(`${ labelNodeFollows.ok ? 'OK ' : 'FAIL' }  external label NODE follows host on move  (${ JSON.stringify(labelNodeFollows.beforeLabel) } → ${ JSON.stringify(labelNodeFollows.afterLabel) })`);
  if (!labelNodeFollows.ok) { exit = 1; console.log(' ', labelNodeFollows); }

  // 7cc. delete also tears down the connect handle (which is hover-bound,
  //      not selection-bound) so it doesn't linger until next mousemove
  await page.evaluate(async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P"><bpmn:task id="T"/></bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="T_di" bpmnElement="T"><dc:Bounds x="200" y="200" width="100" height="80"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await window.modeler.importXML(xml);
  });
  // hover via puppeteer's real mouse so the pointermove listener fires
  const cursor = await page.evaluate(() => {
    const t = window.modeler.getGraph().nodes.find(n => n.type === 'bpmn:Task');
    const gfx = document.querySelector(`[data-element-id="${ t.id }"]`);
    const r = gfx.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(cursor.x, cursor.y, { steps: 4 });
  await new Promise(r => setTimeout(r, 100));

  const deleteConnectHandle = await page.evaluate(async () => {
    const beforeHandle = document.querySelectorAll('.bpmn-xyflow-connect-handle').length;
    const t = window.modeler.getGraph().nodes.find(n => n.type === 'bpmn:Task');
    window.modeler.delete(t);
    await new Promise(r => requestAnimationFrame(r));
    const afterHandle = document.querySelectorAll('.bpmn-xyflow-connect-handle').length;
    return { ok: beforeHandle === 1 && afterHandle === 0, beforeHandle, afterHandle };
  });
  console.log(`${ deleteConnectHandle.ok ? 'OK ' : 'FAIL' }  delete tears down connect handle immediately  (${ deleteConnectHandle.beforeHandle }→${ deleteConnectHandle.afterHandle })`);
  if (!deleteConnectHandle.ok) { exit = 1; console.log(' ', deleteConnectHandle); }

  // 7dd. one user gesture = one undo step. Deleting a shape that has
  //      two connected edges should produce ONE composite undo entry,
  //      not three (one per cascading delete).
  const compoundDelete = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:startEvent id="S"/>
    <bpmn:task id="T"/>
    <bpmn:endEvent id="E"/>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T"/>
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="T_di" bpmnElement="T"><dc:Bounds x="300" y="80" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="E_di" bpmnElement="E"><dc:Bounds x="500" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="F1_di" bpmnElement="F1"><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="136" y="118"/><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="300" y="120"/></bpmndi:BPMNEdge>
    <bpmndi:BPMNEdge id="F2_di" bpmnElement="F2"><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="400" y="120"/><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="500" y="118"/></bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const t = m.getGraph().nodes.find(n => n.type === 'bpmn:Task');
    const beforeShapes = m.getGraph().nodes.length;
    const beforeEdges = m.getGraph().edges.length;

    m.delete(t);  // should compound shape + 2 cascading edges
    const afterShapes = m.getGraph().nodes.length;
    const afterEdges = m.getGraph().edges.length;
    const stackSize1 = m.commandStack.size();

    // single undo restores everything
    m.undo();
    const restoredShapes = m.getGraph().nodes.length;
    const restoredEdges = m.getGraph().edges.length;
    const stackSize2 = m.commandStack.size();

    return {
      ok: stackSize1 === 1 &&
          afterShapes === beforeShapes - 1 && afterEdges === beforeEdges - 2 &&
          restoredShapes === beforeShapes && restoredEdges === beforeEdges &&
          stackSize2 === 0,
      stackAfterDelete: stackSize1,
      stackAfterUndo: stackSize2,
      shapes: { before: beforeShapes, after: afterShapes, restored: restoredShapes },
      edges: { before: beforeEdges, after: afterEdges, restored: restoredEdges }
    };
  });
  console.log(`${ compoundDelete.ok ? 'OK ' : 'FAIL' }  delete shape + edges = 1 undo step  (stack ${ compoundDelete.stackAfterDelete }, shapes ${ compoundDelete.shapes.before }→${ compoundDelete.shapes.after }→${ compoundDelete.shapes.restored }, edges ${ compoundDelete.edges.before }→${ compoundDelete.edges.after }→${ compoundDelete.edges.restored })`);
  if (!compoundDelete.ok) { exit = 1; console.log(' ', compoundDelete); }

  // 7ee. paste of N shapes + M edges = 1 undo step
  const compoundPaste = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:startEvent id="S"/><bpmn:task id="T"/>
    <bpmn:sequenceFlow id="F" sourceRef="S" targetRef="T"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="T_di" bpmnElement="T"><dc:Bounds x="300" y="80" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="F_di" bpmnElement="F"><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="136" y="118"/><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="300" y="120"/></bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    m.select(m.getGraph().nodes.filter(n => !n.waypoints && n.type !== 'label').map(n => n.id));
    const svg = m.getSvg();
    svg.focus();
    svg.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'c', ctrlKey: true }));
    const stackBefore = m.commandStack.size();
    svg.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'v', ctrlKey: true }));
    const stackAfter = m.commandStack.size();
    return { ok: stackAfter - stackBefore === 1, stackBefore, stackAfter };
  });
  console.log(`${ compoundPaste.ok ? 'OK ' : 'FAIL' }  paste = 1 undo step  (stack ${ compoundPaste.stackBefore }→${ compoundPaste.stackAfter })`);
  if (!compoundPaste.ok) { exit = 1; console.log(' ', compoundPaste); }

  // 7ff. Deleting a shape with an external label, attached boundary
  //      events, and edges → ONE compound undo, undo restores all
  const compoundDeleteSiblings = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:startEvent id="S" name="Begin"/>
    <bpmn:task id="T"/>
    <bpmn:boundaryEvent id="B" attachedToRef="T"/>
    <bpmn:sequenceFlow id="F" sourceRef="S" targetRef="T"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S">
      <dc:Bounds x="100" y="100" width="36" height="36"/>
      <bpmndi:BPMNLabel><dc:Bounds x="80" y="140" width="80" height="20"/></bpmndi:BPMNLabel>
    </bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="T_di" bpmnElement="T"><dc:Bounds x="300" y="80" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="B_di" bpmnElement="B"><dc:Bounds x="380" y="142" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="F_di" bpmnElement="F"><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="136" y="118"/><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="300" y="120"/></bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);

    const start = m.getGraph().nodes.find(n => n.businessObject && n.businessObject.id === 'S');
    const labelNode = start.label;
    const beforeNodes = m.getGraph().nodes.length;
    const beforeEdges = m.getGraph().edges.length;
    const labelGfxBefore = labelNode ? !!document.querySelector(`[data-element-id="${ labelNode.id }"]`) : false;

    m.delete(start);
    const afterStackSize = m.commandStack.size();
    const afterNodes = m.getGraph().nodes.length;
    const labelGfxAfter = labelNode ? !!document.querySelector(`[data-element-id="${ labelNode.id }"]`) : false;

    m.undo();
    const restoredNodes = m.getGraph().nodes.length;
    const restoredEdges = m.getGraph().edges.length;
    const labelGfxRestored = labelNode ? !!document.querySelector(`[data-element-id="${ labelNode.id }"]`) : false;

    // Now test boundary cascade. Delete the Task; the BoundaryEvent
    // should also disappear (in the same compound).
    const task = m.getGraph().nodes.find(n => n.businessObject && n.businessObject.id === 'T');
    const beforeWithBoundary = m.getGraph().nodes.length;
    m.delete(task);
    const afterWithoutBoundary = m.getGraph().nodes.length;
    const stackAfterTaskDelete = m.commandStack.size();

    return {
      ok: afterStackSize === 1 &&
          beforeNodes !== afterNodes &&
          labelGfxBefore && !labelGfxAfter &&
          restoredNodes === beforeNodes && restoredEdges === beforeEdges &&
          labelGfxRestored &&
          // task delete cascades the boundary in one compound entry;
          // stack went 0 (after undo) → 1 (after task delete)
          stackAfterTaskDelete === 1 &&
          beforeWithBoundary - afterWithoutBoundary >= 2,
      stack1: afterStackSize, stack2: stackAfterTaskDelete,
      labelLifecycle: { before: labelGfxBefore, after: labelGfxAfter, restored: labelGfxRestored },
      shapesAroundBoundary: { before: beforeWithBoundary, after: afterWithoutBoundary }
    };
  });
  console.log(`${ compoundDeleteSiblings.ok ? 'OK ' : 'FAIL' }  delete cascades label + boundary into one undo  (label ${ compoundDeleteSiblings.labelLifecycle.before }→${ compoundDeleteSiblings.labelLifecycle.after }→${ compoundDeleteSiblings.labelLifecycle.restored }, task+boundary ${ compoundDeleteSiblings.shapesAroundBoundary.before }→${ compoundDeleteSiblings.shapesAroundBoundary.after })`);
  if (!compoundDeleteSiblings.ok) { exit = 1; console.log(' ', compoundDeleteSiblings); }

  // 7gg. Boundary attacher follows its host on move
  const boundaryFollows = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:task id="T"/>
    <bpmn:boundaryEvent id="B" attachedToRef="T"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="T_di" bpmnElement="T"><dc:Bounds x="200" y="200" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="B_di" bpmnElement="B"><dc:Bounds x="280" y="262" width="36" height="36"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const task = m.getGraph().nodes.find(n => n.businessObject.id === 'T');
    const boundary = m.getGraph().nodes.find(n => n.businessObject.id === 'B');
    if (!task || !boundary) return { ok: false, reason: 'missing shapes' };
    const beforeB = { x: boundary.x, y: boundary.y };

    // drag the task by exact graph delta via real mouse
    const gfx = document.querySelector(`[data-element-id="${ task.id }"]`);
    const r = gfx.getBoundingClientRect();
    const v = m.getViewport();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;
    gfx.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: sx, clientY: sy }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: sx + 60 * v.zoom, clientY: sy + 40 * v.zoom }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: sx + 60 * v.zoom, clientY: sy + 40 * v.zoom }));
    const afterB = { x: boundary.x, y: boundary.y };
    return {
      ok: afterB.x !== beforeB.x && afterB.y !== beforeB.y,
      beforeB, afterB, delta: { dx: afterB.x - beforeB.x, dy: afterB.y - beforeB.y }
    };
  });
  console.log(`${ boundaryFollows.ok ? 'OK ' : 'FAIL' }  boundary event follows host on move  (Δ${ JSON.stringify(boundaryFollows.delta) })`);
  if (!boundaryFollows.ok) { exit = 1; console.log(' ', boundaryFollows); }

  // 7hh. Renaming a CONNECTION redraws into the connection layer, not
  //      the shape layer.
  const connectionRenameLayer = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:startEvent id="S"/><bpmn:task id="T"/>
    <bpmn:sequenceFlow id="F" sourceRef="S" targetRef="T"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="T_di" bpmnElement="T"><dc:Bounds x="300" y="80" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="F_di" bpmnElement="F"><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="136" y="118"/><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="300" y="120"/></bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const edge = m.getGraph().edges[0];
    edge.businessObject.name = '';
    // rename via the command stack directly to mirror what the editor does
    m.commandStack.execute({
      name: 'rename',
      do: () => { edge.businessObject.name = 'go'; m.viewer._internals.redrawConnection(edge); },
      undo: () => { edge.businessObject.name = ''; m.viewer._internals.redrawConnection(edge); }
    });
    // The edge gfx must remain in the connection layer (NOT shape layer)
    const inConn = !!document.querySelector('.bpmn-xyflow-connections [data-element-id="' + edge.id + '"]');
    const inShape = !!document.querySelector('.bpmn-xyflow-shapes [data-element-id="' + edge.id + '"]');
    // Undo the rename so state is clean for the export-roundtrip test
    // that runs next (otherwise SequenceFlow.name='go' triggers label
    // node creation on re-import and skews the node count).
    m.undo();
    return { ok: inConn && !inShape, inConn, inShape };
  });
  console.log(`${ connectionRenameLayer.ok ? 'OK ' : 'FAIL' }  connection rename keeps gfx in connection layer  (conn=${ connectionRenameLayer.inConn } shape=${ connectionRenameLayer.inShape })`);
  if (!connectionRenameLayer.ok) { exit = 1; console.log(' ', connectionRenameLayer); }

  // 7ii. Reconnecting an edge updates outgoing/incoming on both old
  //      and new endpoints (moddle tree consistency).
  const reconnectArrays = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:startEvent id="S"/>
    <bpmn:task id="T1"/>
    <bpmn:task id="T2"/>
    <bpmn:sequenceFlow id="F" sourceRef="S" targetRef="T1"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="T1_di" bpmnElement="T1"><dc:Bounds x="300" y="80" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="T2_di" bpmnElement="T2"><dc:Bounds x="300" y="220" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="F_di" bpmnElement="F"><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="136" y="118"/><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="300" y="120"/></bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const t1 = m.getGraph().nodes.find(n => n.businessObject.id === 'T1');
    const t2 = m.getGraph().nodes.find(n => n.businessObject.id === 'T2');
    const edge = m.getGraph().edges[0];
    const beforeT1Incoming = (t1.businessObject.incoming || []).length;
    const beforeT2Incoming = (t2.businessObject.incoming || []).length;

    // drag the edge's target endpoint onto T2
    m.select(edge.id);
    await new Promise(r => requestAnimationFrame(r));
    const handles = document.querySelectorAll('.bpmn-xyflow-bendpoint');
    const targetHandle = handles[handles.length - 1];
    const r = targetHandle.getBoundingClientRect();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;
    const t2Gfx = document.querySelector('[data-element-id="' + t2.id + '"]');
    const tr = t2Gfx.getBoundingClientRect();
    targetHandle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: sx, clientY: sy }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: tr.left + tr.width / 2, clientY: tr.top + tr.height / 2 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: tr.left + tr.width / 2, clientY: tr.top + tr.height / 2 }));

    const afterT1Incoming = (t1.businessObject.incoming || []).length;
    const afterT2Incoming = (t2.businessObject.incoming || []).length;
    return {
      ok: afterT1Incoming === beforeT1Incoming - 1 && afterT2Incoming === beforeT2Incoming + 1,
      beforeT1Incoming, afterT1Incoming, beforeT2Incoming, afterT2Incoming
    };
  });
  console.log(`${ reconnectArrays.ok ? 'OK ' : 'FAIL' }  reconnect maintains incoming/outgoing  (T1.in ${ reconnectArrays.beforeT1Incoming }→${ reconnectArrays.afterT1Incoming }, T2.in ${ reconnectArrays.beforeT2Incoming }→${ reconnectArrays.afterT2Incoming })`);
  if (!reconnectArrays.ok) { exit = 1; console.log(' ', reconnectArrays); }

  // 7jj. Replace shape populates outgoing/incoming on the new bo
  const replaceArrays = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:startEvent id="S"/>
    <bpmn:task id="T"/>
    <bpmn:endEvent id="E"/>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T"/>
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="T_di" bpmnElement="T"><dc:Bounds x="300" y="80" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="E_di" bpmnElement="E"><dc:Bounds x="500" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="F1_di" bpmnElement="F1"><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="136" y="118"/><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="300" y="120"/></bpmndi:BPMNEdge>
    <bpmndi:BPMNEdge id="F2_di" bpmnElement="F2"><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="400" y="120"/><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="500" y="118"/></bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const task = m.getGraph().nodes.find(n => n.businessObject.id === 'T');
    m.replace(task, 'bpmn:UserTask');
    const newBo = task.businessObject;
    return {
      ok: Array.isArray(newBo.outgoing) && newBo.outgoing.length === 1 &&
          Array.isArray(newBo.incoming) && newBo.incoming.length === 1,
      out: newBo.outgoing ? newBo.outgoing.length : 'undef',
      in: newBo.incoming ? newBo.incoming.length : 'undef',
      newType: task.type
    };
  });
  console.log(`${ replaceArrays.ok ? 'OK ' : 'FAIL' }  replace populates new bo's outgoing/incoming  (type=${ replaceArrays.newType }, out=${ replaceArrays.out }, in=${ replaceArrays.in })`);
  if (!replaceArrays.ok) { exit = 1; console.log(' ', replaceArrays); }

  // 7kk. Renaming an event from empty → 'Begin' creates a rendered label
  const renameCreatesLabel = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P"><bpmn:startEvent id="S"/></bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S"><dc:Bounds x="200" y="200" width="36" height="36"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    const beforeLabelNode = !!start.label;
    const beforeLabelGfx = !!document.querySelector('.bpmn-xyflow-labels [data-element-id]');

    // open and commit the inline editor at zoom=1
    m.setViewport({ x: 0, y: 0, zoom: 1 });
    const gfx = document.querySelector('[data-element-id="' + start.id + '"]');
    const r = gfx.getBoundingClientRect();
    gfx.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    await new Promise(r => requestAnimationFrame(r));
    const editor = document.querySelector('[contenteditable="true"]');
    if (!editor) return { ok: false, reason: 'no editor' };
    editor.textContent = 'Begin';
    editor.blur();
    await new Promise(r => requestAnimationFrame(r));

    const afterLabelNode = !!start.label;
    const afterLabelGfx = !!document.querySelector('.bpmn-xyflow-labels [data-element-id]');
    return {
      ok: !beforeLabelNode && afterLabelNode && !beforeLabelGfx && afterLabelGfx,
      beforeLabelNode, afterLabelNode, beforeLabelGfx, afterLabelGfx
    };
  });
  console.log(`${ renameCreatesLabel.ok ? 'OK ' : 'FAIL' }  rename '' → 'Begin' creates label node + gfx  (node ${ renameCreatesLabel.beforeLabelNode }→${ renameCreatesLabel.afterLabelNode }, gfx ${ renameCreatesLabel.beforeLabelGfx }→${ renameCreatesLabel.afterLabelGfx })`);
  if (!renameCreatesLabel.ok) { exit = 1; console.log(' ', renameCreatesLabel); }

  // 7ll. After drillInto a SubProcess, addShape places the new bo in
  //      the SubProcess's flowElements and its di in the SubProcess's
  //      plane — NOT the root Process / root plane.
  const drillAddShape = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:subProcess id="SP"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="SP_di" bpmnElement="SP" isExpanded="true"><dc:Bounds x="100" y="100" width="350" height="200"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    const sp = m.getGraph().nodes.find(n => n.businessObject.id === 'SP');
    await m.drillInto(sp);
    await new Promise(r => requestAnimationFrame(r));

    // before adding: SubProcess has no flowElements yet
    const beforeSpFlowCount = (sp.businessObject.flowElements || []).length;
    const beforePFlowCount = (sp.businessObject.$parent && sp.businessObject.$parent.flowElements || []).length;

    const node = m.addShape('bpmn:Task', { x: 250, y: 200 });
    if (!node) return { ok: false, reason: 'addShape returned null' };

    const afterSpFlowCount = (sp.businessObject.flowElements || []).length;
    const afterPFlowCount = (sp.businessObject.$parent.flowElements || []).length;

    // The new task should be in SP.flowElements, not in P.flowElements
    const taskParent = node.businessObject.$parent;
    const inSp = afterSpFlowCount === beforeSpFlowCount + 1;
    const notInP = afterPFlowCount === beforePFlowCount;
    return {
      ok: inSp && notInP && taskParent === sp.businessObject,
      inSp, notInP,
      taskParent: taskParent && taskParent.id,
      spFlow: { before: beforeSpFlowCount, after: afterSpFlowCount },
      pFlow: { before: beforePFlowCount, after: afterPFlowCount }
    };
  });
  console.log(`${ drillAddShape.ok ? 'OK ' : 'FAIL' }  addShape after drillInto goes into SubProcess  (SP.flow ${ drillAddShape.spFlow.before }→${ drillAddShape.spFlow.after }, P.flow ${ drillAddShape.pFlow.before }→${ drillAddShape.pFlow.after })`);
  if (!drillAddShape.ok) { exit = 1; console.log(' ', drillAddShape); }

  // 7mm. Connection drawn inside a SubProcess belongs to
  //      SubProcess.flowElements, not the parent Process's
  const drillConnect = await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:subProcess id="SP">
      <bpmn:task id="T1"/>
      <bpmn:task id="T2"/>
    </bpmn:subProcess>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="rootD"><bpmndi:BPMNPlane id="rootP" bpmnElement="P">
    <bpmndi:BPMNShape id="SP_di" bpmnElement="SP" isExpanded="false"><dc:Bounds x="100" y="100" width="200" height="120"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
  <bpmndi:BPMNDiagram id="spD"><bpmndi:BPMNPlane id="spP" bpmnElement="SP">
    <bpmndi:BPMNShape id="T1_di" bpmnElement="T1"><dc:Bounds x="50" y="100" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="T2_di" bpmnElement="T2"><dc:Bounds x="200" y="100" width="100" height="80"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml, 'spD');
    const t1 = m.getGraph().nodes.find(n => n.businessObject.id === 'T1');
    const t2 = m.getGraph().nodes.find(n => n.businessObject.id === 'T2');
    if (!t1 || !t2) return { ok: false, reason: 'tasks missing' };

    const sp = t1.businessObject.$parent;
    const p = sp.$parent;
    const beforeSpFlow = (sp.flowElements || []).length;
    const beforePFlow = (p.flowElements || []).length;

    const edge = m.connect(t1, t2);
    const afterSpFlow = (sp.flowElements || []).length;
    const afterPFlow = (p.flowElements || []).length;
    return {
      ok: !!edge && afterSpFlow === beforeSpFlow + 1 && afterPFlow === beforePFlow,
      edgeParent: edge && edge.businessObject.$parent && edge.businessObject.$parent.id,
      sp: { before: beforeSpFlow, after: afterSpFlow },
      p: { before: beforePFlow, after: afterPFlow }
    };
  });
  console.log(`${ drillConnect.ok ? 'OK ' : 'FAIL' }  connect inside SubProcess goes to SubProcess.flowElements  (SP ${ drillConnect.sp.before }→${ drillConnect.sp.after }, P ${ drillConnect.p.before }→${ drillConnect.p.after })`);
  if (!drillConnect.ok) { exit = 1; console.log(' ', drillConnect); }

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
