#!/usr/bin/env node
/**
 * Smoke test for the React wrapper. Boots demo, opens /react, asserts the
 * BpmnViewer mounted, rendered, and emits selection events.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = 5191;
const BASE = `http://localhost:${ PORT }`;

const proc = spawn(process.execPath, [ path.join(__dirname, '..', 'serve.mjs') ], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: [ 'ignore', 'pipe', 'inherit' ]
});
proc.stdout.on('data', () => {});

async function waitForServer() {
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(BASE + '/react');
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server timeout');
}

let exit = 0;
let browser;
try {
  await waitForServer();

  browser = await puppeteer.launch({ headless: 'shell' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });

  const consoleMsgs = [];
  page.on('console', m => consoleMsgs.push(`[${ m.type() }] ${ m.text() }`));
  page.on('pageerror', e => {
    const msg = `[pageerror] ${ e.message }`;
    consoleMsgs.push(msg);
    console.log(msg);
  });

  await page.goto(BASE + '/react', { waitUntil: 'networkidle0' });

  await page.waitForFunction(() => /^Loaded/.test(document.getElementById('status')?.textContent || ''), { timeout: 30000 }).catch(async () => {
    console.log('initial load timeout, status =', await page.evaluate(() => document.getElementById('status')?.textContent));
    consoleMsgs.forEach(m => console.log(m));
    throw new Error('initial load timeout');
  });

  const result = await page.evaluate(async () => {
    const shapes = document.querySelectorAll('.bpmn-xyflow-shape').length;
    const conns = document.querySelectorAll('.bpmn-xyflow-connection').length;

    // pick a shape and click it
    const shape = document.querySelector('.bpmn-xyflow-shape');
    if (!shape) return { error: 'no shape' };
    const id = shape.getAttribute('data-element-id');
    const rect = shape.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const opts = { bubbles: true, clientX: cx, clientY: cy };
    shape.dispatchEvent(new PointerEvent('pointerdown', opts));
    shape.dispatchEvent(new PointerEvent('pointerup', opts));

    // wait one tick for React state update
    await new Promise(r => setTimeout(r, 50));

    const selection = document.getElementById('selection').textContent;
    return { shapes, conns, id, selection };
  });

  if (result.error) {
    console.log('FAIL', result.error);
    exit = 1;
  } else {
    const ok = result.shapes >= 1 && result.selection.includes('Selected:');
    console.log(`${ ok ? 'OK ' : 'FAIL' }  React BpmnViewer  shapes=${ result.shapes } conns=${ result.conns } selection="${ result.selection }"`);
    if (!ok) exit = 1;
  }

} catch (e) {
  console.error(e);
  exit = 1;
} finally {
  if (browser) await browser.close();
  proc.kill('SIGTERM');
}

process.exit(exit);
