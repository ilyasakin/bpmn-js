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

    browser = await puppeteer.launch({ headless: 'new' });
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
