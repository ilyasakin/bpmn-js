#!/usr/bin/env node
/**
 * Smoke test that exercises the React, Vue, and Svelte wrappers in
 * sequence: each framework demo is loaded, click a shape, assert the
 * framework's reactive selection state propagated back to the toolbar.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = 5193;
const BASE = `http://localhost:${ PORT }`;

const FRAMEWORKS = [
  { name: 'react',  path: '/react' },
  { name: 'vue',    path: '/vue' },
  { name: 'svelte', path: '/svelte' }
];

const proc = spawn(process.execPath, [ path.join(__dirname, 'serve.mjs') ], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: [ 'ignore', 'pipe', 'inherit' ]
});
proc.stdout.on('data', () => {});

async function waitForServer() {
  for (let i = 0; i < 240; i++) {
    try { const r = await fetch(BASE); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server timeout');
}

let exit = 0;
let browser;
try {
  await waitForServer();

  browser = await puppeteer.launch({ headless: 'shell' });

  for (const fw of FRAMEWORKS) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(BASE + fw.path, { waitUntil: 'networkidle0' });

    try {
      await page.waitForFunction(
        () => /^Loaded/.test(document.getElementById('status')?.textContent || ''),
        { timeout: 30000 }
      );
    } catch (e) {
      const status = await page.evaluate(() => document.getElementById('status')?.textContent);
      console.log(`FAIL  ${ fw.name.padEnd(7) }  load timeout, status="${ status }", errors=${ errors.length }`);
      errors.forEach(m => console.log('  ', m));
      exit = 1;
      await page.close();
      continue;
    }

    const result = await page.evaluate(async () => {
      const shapes = document.querySelectorAll('.bpmn-xyflow-shape').length;
      const conns  = document.querySelectorAll('.bpmn-xyflow-connection').length;
      const minimap = document.querySelectorAll('.bpmn-xyflow-minimap rect').length;

      const shape = document.querySelector('.bpmn-xyflow-shape');
      if (!shape) return { shapes, conns, minimap, error: 'no shape' };
      const rect = shape.getBoundingClientRect();
      const opts = { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      shape.dispatchEvent(new PointerEvent('pointerdown', opts));
      shape.dispatchEvent(new PointerEvent('pointerup', opts));

      // wait for framework reactive update tick
      await new Promise(r => setTimeout(r, 100));

      const selectionText = document.getElementById('selection')?.textContent || '';
      return { shapes, conns, minimap, selectionText };
    });

    const ok = result.shapes >= 1 && result.minimap > 0 && /Selected:/.test(result.selectionText || '');
    console.log(`${ ok ? 'OK ' : 'FAIL' }  ${ fw.name.padEnd(7) }  shapes=${ result.shapes } minimap=${ result.minimap } selection="${ result.selectionText }"`);
    if (!ok) {
      exit = 1;
      if (errors.length) errors.forEach(m => console.log('   error:', m));
    }

    await page.close();
  }
} catch (e) {
  console.error(e);
  exit = 1;
} finally {
  if (browser) await browser.close();
  proc.kill('SIGTERM');
}

process.exit(exit);
