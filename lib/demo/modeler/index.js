import { Modeler } from '../../index';

const SAMPLES = [
  { label: 'Empty diagram', path: 'empty-process.bpmn' },
  { label: 'Basic', path: 'basic.bpmn' },
  { label: 'Conditional flows', path: 'draw/conditional-flow.bpmn' }
];

const FIXTURE_BASE = '/test/fixtures/bpmn/';

const EMPTY_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
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

const container = document.getElementById('viewer');
const select = document.getElementById('sample-select');
const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');
const exportBtn = document.getElementById('export-btn');
const status = document.getElementById('status');
const xmlOut = document.getElementById('xml-out');

SAMPLES.forEach((s, i) => {
  const opt = document.createElement('option');
  opt.value = i;
  opt.textContent = s.label;
  select.appendChild(opt);
});

const modeler = new Modeler({
  container,
  fitViewOnInit: true,
  minimap: true
});

window.modeler = modeler;

modeler.commandStack.onChange(({ canUndo, canRedo }) => {
  undoBtn.disabled = !canUndo;
  redoBtn.disabled = !canRedo;
});

modeler.on('selection.change', ({ ids }) => {
  status.textContent = ids.length ? `Selected: ${ ids.length } element(s)` : '';
});

async function loadSample(idx) {
  const sample = SAMPLES[idx];
  let xml;
  if (sample.path === 'empty-process.bpmn') {
    xml = EMPTY_BPMN;
  } else {
    const res = await fetch(FIXTURE_BASE + sample.path);
    xml = await res.text();
  }
  status.textContent = `Loading ${ sample.label }...`;
  try {
    const result = await modeler.importXML(xml);
    status.textContent = `Loaded ${ sample.label } (${ result.warnings.length } warnings)`;
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
    console.error(e);
  }
}

select.addEventListener('change', () => loadSample(+select.value));
undoBtn.addEventListener('click', () => modeler.undo());
redoBtn.addEventListener('click', () => modeler.redo());

exportBtn.addEventListener('click', async () => {
  const xml = await modeler.getXML();
  xmlOut.style.display = 'block';
  xmlOut.textContent = xml;
});

loadSample(0);
