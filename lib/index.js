/**
 * Public entry of bpmn-js.
 *
 * The implementation is the @xyflow/system-based viewer/modeler that
 * lives directly under lib/. Older diagram-js-based modules
 * (BaseViewer / BaseModeler / NavigatedViewer / lib/core / lib/features)
 * have been removed in favour of this implementation; the existing
 * lib/draw, lib/import, lib/util, and lib/model directories are still
 * used because BpmnRenderer / TextRenderer / PathMap / BpmnTreeWalker
 * are reused unchanged.
 */

export { default } from './Viewer';
export { default as Viewer } from './Viewer';
export { default as Modeler } from './Modeler';
export { default as Renderer } from './Renderer';
export { default as CommandStack } from './modeling/CommandStack';
export { parseBpmnXML, buildGraph } from './Importer';

// Legacy aliases retained for the period after the xyflow port
// landed; some demos and downstream code still reach for these.
export { default as BpmnXyflowViewer } from './Viewer';
export { default as BpmnXyflowModeler } from './Modeler';
