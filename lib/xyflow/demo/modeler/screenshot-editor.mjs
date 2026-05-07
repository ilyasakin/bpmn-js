#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const PORT = 5601;
const proc = spawn(process.execPath, [ path.join(__dirname, '..', 'serve.mjs') ], {
  env: { ...process.env, PORT: String(PORT) }, stdio: [ 'ignore', 'pipe', 'inherit' ]
});
proc.stdout.on('data', () => {});

async function waitForServer() {
  for (let i = 0; i < 240; i++) {
    try { const r = await fetch(`http://localhost:${ PORT }/modeler`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
}

let exit = 0;
try {
  await waitForServer();
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(`http://localhost:${ PORT }/modeler`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => /^Loaded/.test(document.getElementById('status').textContent), { timeout: 30000 });

  // 1) Inline-label editor on a Task
  await page.evaluate(async () => {
    const m = window.modeler;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="x">
  <bpmn:process id="P">
    <bpmn:startEvent id="S"/><bpmn:task id="T" name="Existing"/><bpmn:endEvent id="E"/>
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T"/>
    <bpmn:sequenceFlow id="F2" sourceRef="T" targetRef="E"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="d"><bpmndi:BPMNPlane id="p" bpmnElement="P">
    <bpmndi:BPMNShape id="S_di" bpmnElement="S"><dc:Bounds x="200" y="200" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="T_di" bpmnElement="T"><dc:Bounds x="320" y="180" width="120" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="E_di" bpmnElement="E"><dc:Bounds x="540" y="200" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="F1_di" bpmnElement="F1"><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="236" y="218"/><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="320" y="220"/></bpmndi:BPMNEdge>
    <bpmndi:BPMNEdge id="F2_di" bpmnElement="F2"><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="440" y="220"/><di:waypoint xmlns:di="http://www.omg.org/spec/DD/20100524/DI" x="540" y="218"/></bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    await m.importXML(xml);
    m.setViewport({ x: 200, y: 100, zoom: 2 });
  });
  await new Promise(r => setTimeout(r, 200));

  // open editor on the Task
  await page.evaluate(() => {
    const t = window.modeler.getGraph().nodes.find(n => n.businessObject.id === 'T');
    const gfx = document.querySelector('[data-element-id="' + t.id + '"]');
    const r = gfx.getBoundingClientRect();
    gfx.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  });
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: path.join(repoRoot, 'editor-task.png') });

  // commit current editor and open one on the Start event
  await page.evaluate(() => {
    const ed = document.querySelector('[contenteditable]');
    if (ed) ed.blur();
  });
  await new Promise(r => setTimeout(r, 100));

  await page.evaluate(() => {
    const s = window.modeler.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    const gfx = document.querySelector('[data-element-id="' + s.id + '"]');
    const r = gfx.getBoundingClientRect();
    gfx.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  });
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: path.join(repoRoot, 'editor-event.png') });

  await page.evaluate(() => {
    const ed = document.querySelector('[contenteditable]');
    if (ed) ed.blur();
  });
  await new Promise(r => setTimeout(r, 100));

  // edit a connection name
  await page.evaluate(() => {
    const e = window.modeler.getGraph().edges[0];
    const gfx = document.querySelector('[data-element-id="' + e.id + '"]');
    const r = gfx.getBoundingClientRect();
    gfx.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  });
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: path.join(repoRoot, 'editor-edge.png') });

  console.log('wrote editor-task.png, editor-event.png, editor-edge.png');
  await browser.close();
} catch (e) {
  console.error(e);
  exit = 1;
} finally {
  proc.kill('SIGTERM');
}

process.exit(exit);
