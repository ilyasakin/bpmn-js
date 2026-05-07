import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { BpmnViewer } from '../../react';

const SAMPLES = [
  { label: 'Basic', path: 'basic.bpmn' },
  { label: 'Task types', path: 'draw/task-types.bpmn' },
  { label: 'Conditional flows', path: 'draw/conditional-flow.bpmn' },
  { label: 'Pools', path: 'collaboration.bpmn' },
  { label: 'Complex', path: 'complex.bpmn' }
];

const FIXTURE_BASE = '/test/fixtures/bpmn/';

function App() {
  const [ idx, setIdx ] = useState(0);
  const [ xml, setXml ] = useState('');
  const [ status, setStatus ] = useState('');
  const [ selection, setSelection ] = useState([]);
  const viewerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('Fetching ' + SAMPLES[idx].label + '...');
    fetch(FIXTURE_BASE + SAMPLES[idx].path)
      .then(r => r.text())
      .then(text => {
        if (cancelled) return;
        setXml(text);
      });
    return () => { cancelled = true; };
  }, [ idx ]);

  return React.createElement('div', { className: 'app' }, [
    React.createElement('div', { className: 'toolbar', key: 'tb' }, [
      React.createElement('select', {
        key: 's', value: idx,
        onChange: e => setIdx(Number(e.target.value))
      }, SAMPLES.map((s, i) => React.createElement('option', { key: i, value: i }, s.label))),
      React.createElement('button', {
        key: 'fit',
        onClick: () => viewerRef.current?.fitView()
      }, 'Fit view'),
      React.createElement('button', {
        key: 'reset',
        onClick: () => viewerRef.current?.setViewport({ x: 0, y: 0, zoom: 1 })
      }, 'Reset'),
      React.createElement('span', { key: 'spacer', className: 'spacer' }),
      React.createElement('span', {
        key: 'sel', className: 'info', id: 'selection'
      }, selection.length ? `Selected: ${ selection.map(e => e.type.replace('bpmn:', '') + (e.businessObject.name ? ` "${ e.businessObject.name }"` : '')).join(', ') }` : ''),
      React.createElement('span', { key: 'st', className: 'info', id: 'status' }, status)
    ]),
    React.createElement('div', { key: 'host', className: 'viewer-host' },
      xml ? React.createElement(BpmnViewer, {
        ref: viewerRef,
        xml,
        minimap: true,
        onLoad: result => setStatus(`Loaded (${ result.warnings.length } warnings)`),
        onError: err => setStatus('Error: ' + err.message),
        onSelectionChange: ({ elements }) => setSelection(elements)
      }) : null)
  ]);
}

const root = createRoot(document.getElementById('root'));
root.render(React.createElement(App));

window.__bpmn_react_app = { setSample: (i) => {
  const evt = new Event('change', { bubbles: true });
  const sel = document.querySelector('select');
  sel.value = String(i);
  sel.dispatchEvent(evt);
} };
