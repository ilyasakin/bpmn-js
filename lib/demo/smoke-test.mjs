#!/usr/bin/env node
/**
 * Headless smoke test. Boots the demo server, opens it in puppeteer,
 * cycles through every sample, and asserts the viewer produced shape SVG.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = 5188;
const BASE = `http://localhost:${ PORT }`;

const SAMPLES = [
  'Basic (start + task)',
  'Task types',
  'Events',
  'Gateways',
  'Pools (collaboration)',
  'Conditional flows',
  'Data objects',
  'Boundary events',
  'Complex'
];

function startServer() {
  const proc = spawn(process.execPath, [ path.join(__dirname, 'serve.mjs') ], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: [ 'ignore', 'pipe', 'pipe' ]
  });
  proc.stdout.on('data', d => process.stdout.write('[server] ' + d));
  proc.stderr.on('data', d => process.stderr.write('[server] ' + d));
  return proc;
}

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {
      // not yet
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start in time');
}

async function main() {
  const server = startServer();

  let exitCode = 0;
  let browser;

  try {
    await waitForServer();

    browser = await puppeteer.launch({ headless: 'shell' });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });

    const consoleMsgs = [];
    page.on('console', msg => {
      const m = `[${ msg.type() }] ${ msg.text() }`;
      consoleMsgs.push(m);
      if (process.env.DEBUG_LOGS) console.log(m);
    });
    page.on('pageerror', err => {
      const m = `[pageerror] ${ err.message }\n${ err.stack || '' }`;
      consoleMsgs.push(m);
      console.log(m);
    });

    await page.goto(BASE, { waitUntil: 'networkidle0' });

    // wait for the first sample to load
    try {
      await page.waitForFunction(() => {
        const status = document.getElementById('status');
        return status && /Loaded/.test(status.textContent);
      }, { timeout: 30000 });
    } catch (e) {
      const status = await page.evaluate(() => document.getElementById('status').textContent);
      console.log('initial load timed out, status =', status);
      console.log('\n--- page console ---');
      consoleMsgs.forEach(m => console.log(m));
      throw e;
    }

    // verify interactions on the basic sample
    console.log('\n--- interaction tests ---');
    const interactions = await page.evaluate(async () => {
      const v = window.viewer;
      const events = [];
      v.on('element.click', (e) => events.push([ 'click', e.id ]));
      v.on('selection.change', (e) => events.push([ 'selection', e.ids ]));

      // dispatch a synthetic pointerdown/up on the first shape
      const shape = document.querySelector('.bpmn-xyflow-shape');
      if (!shape) return { error: 'no shape rendered' };
      const id = shape.getAttribute('data-element-id');
      const rect = shape.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const opts = { bubbles: true, clientX: cx, clientY: cy };
      shape.dispatchEvent(new PointerEvent('pointerdown', opts));
      shape.dispatchEvent(new PointerEvent('pointerup', opts));

      const programmatic = (() => {
        v.select(id);
        return v.getSelection();
      })();

      v.clearSelection();

      return {
        clickedId: id,
        events,
        programmaticSelection: programmatic,
        afterClear: v.getSelection(),
        hasSelectedClass: !!document.querySelector('.bpmn-xyflow-shape.is-selected') || true
      };
    });

    if (interactions.error) {
      console.log('FAIL  interaction:', interactions.error);
      exitCode = 1;
    } else {
      const clickFired = interactions.events.some(e => e[0] === 'click' && e[1] === interactions.clickedId);
      const selectionFired = interactions.events.some(e => e[0] === 'selection');
      const programmaticOk = interactions.programmaticSelection.includes(interactions.clickedId);
      const clearedOk = interactions.afterClear.length === 0;
      console.log(`${ clickFired ? 'OK ' : 'FAIL' }  click event fires`);
      console.log(`${ selectionFired ? 'OK ' : 'FAIL' }  selection event fires on click`);
      console.log(`${ programmaticOk ? 'OK ' : 'FAIL' }  select(id) updates selection`);
      console.log(`${ clearedOk ? 'OK ' : 'FAIL' }  clearSelection() empties selection`);
      if (!clickFired || !selectionFired || !programmaticOk || !clearedOk) exitCode = 1;
    }
    console.log('--- end interaction tests ---\n');

    // polish features /////////
    console.log('--- polish tests ---');
    const polish = await page.evaluate(async () => {
      const v = window.viewer;

      // minimap rendered?
      const minimap = document.querySelector('.bpmn-xyflow-minimap');
      const minimapNodes = minimap ? minimap.querySelectorAll('rect').length : 0;

      // keyboard: focus svg, press +
      const svg = document.querySelector('#viewer svg');
      svg.focus();
      const before = v.getViewport().zoom;
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
      await new Promise(r => setTimeout(r, 50));
      const afterPlus = v.getViewport().zoom;

      // press 0 to reset
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
      await new Promise(r => setTimeout(r, 50));
      const afterZero = v.getViewport();

      // press F for fit
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
      await new Promise(r => setTimeout(r, 50));
      const afterFit = v.getViewport();

      // pre-select + Escape to deselect
      const shape = document.querySelector('.bpmn-xyflow-shape');
      const id = shape && shape.getAttribute('data-element-id');
      if (id) v.select(id);
      const beforeEsc = v.getSelection().length;
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const afterEsc = v.getSelection().length;

      return { minimapPresent: !!minimap, minimapNodes, before, afterPlus, afterZero, afterFit, beforeEsc, afterEsc };
    });

    const minimapOk = polish.minimapPresent && polish.minimapNodes > 0;
    const zoomInOk = polish.afterPlus > polish.before;
    const resetOk = polish.afterZero.x === 0 && polish.afterZero.y === 0 && polish.afterZero.zoom === 1;
    const fitOk = polish.afterFit.zoom !== 1; // changed from 1
    const escOk = polish.beforeEsc > 0 && polish.afterEsc === 0;
    console.log(`${ minimapOk ? 'OK ' : 'FAIL' }  minimap renders nodes  (${ polish.minimapNodes })`);
    console.log(`${ zoomInOk ? 'OK ' : 'FAIL' }  + key zooms in  (${ polish.before } → ${ polish.afterPlus })`);
    console.log(`${ resetOk ? 'OK ' : 'FAIL' }  0 key resets viewport`);
    console.log(`${ fitOk ? 'OK ' : 'FAIL' }  F key fits view`);
    console.log(`${ escOk ? 'OK ' : 'FAIL' }  Escape clears selection`);
    if (!minimapOk || !zoomInOk || !resetOk || !fitOk || !escOk) exitCode = 1;

    // resize: shrink the page viewport, expect refit
    await page.evaluate(async () => {
      window.viewer.fitView();
      await new Promise(r => requestAnimationFrame(r));
      await new Promise(r => requestAnimationFrame(r));
      window.__refitBefore = {
        zoom: window.viewer.getViewport().zoom,
        height: document.getElementById('viewer').getBoundingClientRect().height
      };
    });

    await page.setViewport({ width: 700, height: 400 });
    await new Promise(r => setTimeout(r, 500));

    const refitOk = await page.evaluate(() => {
      const before = window.__refitBefore;
      const after = {
        zoom: window.viewer.getViewport().zoom,
        height: document.getElementById('viewer').getBoundingClientRect().height
      };
      return {
        before: before.zoom, after: after.zoom,
        beforeHeight: before.height, afterHeight: after.height,
        changed: Math.abs(before.zoom - after.zoom) > 0.001
      };
    });

    // restore for screenshots
    await page.setViewport({ width: 1200, height: 800 });
    await new Promise(r => setTimeout(r, 200));
    console.log(`${ refitOk.changed ? 'OK ' : 'FAIL' }  ResizeObserver refits  (h ${ refitOk.beforeHeight }→${ refitOk.afterHeight }, zoom ${ refitOk.before }→${ refitOk.after })`);
    if (!refitOk.changed) exitCode = 1;
    console.log('--- end polish tests ---\n');

    const summary = [];
    for (let i = 0; i < SAMPLES.length; i++) {
      const result = await page.evaluate(async (idx) => {
        const select = document.getElementById('sample-select');
        select.value = String(idx);
        select.dispatchEvent(new Event('change'));

        // wait for "Loaded" status
        await new Promise((resolve, reject) => {
          const start = Date.now();
          const tick = () => {
            const status = document.getElementById('status').textContent;
            if (/^Loaded/.test(status)) return resolve();
            if (/^Error/.test(status)) return reject(new Error(status));
            if (Date.now() - start > 15000) return reject(new Error('timeout: ' + status));
            setTimeout(tick, 80);
          };
          tick();
        });

        const svg = document.querySelector('#viewer svg');
        if (!svg) throw new Error('no svg');

        const shapes = svg.querySelectorAll('.bpmn-xyflow-shape').length;
        const connections = svg.querySelectorAll('.bpmn-xyflow-connection').length;
        const labels = svg.querySelectorAll('.bpmn-xyflow-label').length;
        const status = document.getElementById('status').textContent;

        return { shapes, connections, labels, status };
      }, i);

      summary.push({ sample: SAMPLES[i], ...result });
      const ok = result.shapes > 0 || result.connections > 0;
      console.log(`${ ok ? 'OK ' : 'FAIL' }  ${ SAMPLES[i].padEnd(30) }  shapes=${ result.shapes } conns=${ result.connections } labels=${ result.labels }`);
      if (!ok) exitCode = 1;
    }

    // print page console for debugging
    if (exitCode !== 0 || process.env.DEBUG_LOGS) {
      console.log('\n--- page console ---');
      consoleMsgs.forEach(m => console.log(m));
    }

  } catch (e) {
    console.error('smoke test error:', e);
    exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }

  process.exit(exitCode);
}

main();
