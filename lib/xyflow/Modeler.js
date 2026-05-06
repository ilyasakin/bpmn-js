/* eslint-env browser */

import {
  append as svgAppend,
  attr as svgAttr,
  create as svgCreate
} from 'tiny-svg';

import { BpmnModdle } from 'bpmn-moddle';

import { getElementLineIntersection } from 'diagram-js/lib/layout/LayoutUtil';
import { componentsToPath } from 'diagram-js/lib/util/RenderUtil';

import BpmnXyflowViewer from './Viewer';
import CommandStack from './modeling/CommandStack';

const SVG_NS = 'http://www.w3.org/2000/svg';

const DEFAULT_SHAPE_SIZES = {
  'bpmn:Task': { width: 100, height: 80 },
  'bpmn:UserTask': { width: 100, height: 80 },
  'bpmn:ServiceTask': { width: 100, height: 80 },
  'bpmn:StartEvent': { width: 36, height: 36 },
  'bpmn:EndEvent': { width: 36, height: 36 },
  'bpmn:IntermediateThrowEvent': { width: 36, height: 36 },
  'bpmn:IntermediateCatchEvent': { width: 36, height: 36 },
  'bpmn:ExclusiveGateway': { width: 50, height: 50 },
  'bpmn:ParallelGateway': { width: 50, height: 50 },
  'bpmn:InclusiveGateway': { width: 50, height: 50 },
  'bpmn:SubProcess': { width: 350, height: 200 }
};

let idCounter = 0;
function nextId(prefix) {
  idCounter += 1;
  return `${ prefix }_${ Date.now().toString(36) }_${ idCounter }`;
}

function getMid(node) {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

/**
 * Intersect the ray from node's mid to externalPoint with the node's
 * axis-aligned bounding box. Returns the point on the box edge.
 *
 * Used so connections stop at shape boundaries instead of passing
 * through the interior — both for visual correctness and so a click on
 * a shape body doesn't hit the connection's <path> sitting on top.
 */
function intersectBox(node, externalPoint) {
  const mid = getMid(node);
  const dx = externalPoint.x - mid.x;
  const dy = externalPoint.y - mid.y;
  if (dx === 0 && dy === 0) return mid;

  const halfW = (node.width || 0) / 2;
  const halfH = (node.height || 0) / 2;

  const tx = dx === 0 ? Infinity : Math.abs(halfW / dx);
  const ty = dy === 0 ? Infinity : Math.abs(halfH / dy);
  const t = Math.min(tx, ty);

  return { x: mid.x + dx * t, y: mid.y + dy * t };
}

function computeWaypoints(source, target) {
  const sourceMid = getMid(source);
  const targetMid = getMid(target);
  return [
    intersectBox(source, targetMid),
    intersectBox(target, sourceMid)
  ];
}

/**
 * Crop the first/last waypoint of a connection to the actual shape
 * outline (circle for events, diamond for gateways, rounded rect for
 * activities, etc.) using the BpmnRenderer's per-shape path.
 *
 * Mirrors diagram-js's CroppingConnectionDocking.
 */
function cropWaypoints(waypoints, source, target, bpmnRenderer) {
  if (waypoints.length < 2) return waypoints;

  const linePath = componentsToPath(
    waypoints.map((p, i) => [ i === 0 ? 'M' : 'L', p.x, p.y ])
  );

  const result = waypoints.slice();
  if (source && bpmnRenderer.getShapePath) {
    try {
      const sp = bpmnRenderer.getShapePath(source);
      const cropped = getElementLineIntersection(sp, linePath, true);
      if (cropped) result[0] = { x: cropped.x, y: cropped.y };
    } catch (e) { /* fallback to existing waypoint */ }
  }
  if (target && bpmnRenderer.getShapePath) {
    try {
      const tp = bpmnRenderer.getShapePath(target);
      const cropped = getElementLineIntersection(tp, linePath, false);
      if (cropped) result[result.length - 1] = { x: cropped.x, y: cropped.y };
    } catch (e) { /* fallback */ }
  }
  return result;
}

/**
 * BpmnXyflowModeler
 *
 * Read-only viewer + minimal modeling layer:
 *  - drag shapes to move them
 *  - drag from a shape onto another to create a SequenceFlow
 *  - Delete/Backspace removes selected
 *  - palette buttons add new shapes
 *  - double-click inline-edits a label
 *  - Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z for undo/redo
 *  - getXML() returns the current BPMN serialization
 */
export default function BpmnXyflowModeler(options = {}) {
  const opts = Object.assign({
    palette: true,
    keyboard: true
  }, options);

  // delegate to the viewer for rendering, pan/zoom, selection, etc.
  const viewer = new BpmnXyflowViewer(opts);
  const internals = viewer._internals;

  const commands = CommandStack();

  // moddle instance for creating new business objects
  const moddle = BpmnModdle();

  // Forward viewer surface ////////
  this.viewer = viewer;
  this.commandStack = commands;
  this.on = viewer.on;
  this.off = viewer.off;
  this.fitView = viewer.fitView;
  this.setViewport = viewer.setViewport;
  this.getViewport = viewer.getViewport;
  this.select = viewer.select;
  this.deselect = viewer.deselect;
  this.getSelection = viewer.getSelection;
  this.clearSelection = viewer.clearSelection;
  this.getElement = viewer.getElement;
  this.getGraph = viewer.getGraph;
  this.getDefinitions = viewer.getDefinitions;
  this.getContainer = viewer.getContainer;
  this.getSvg = viewer.getSvg;
  this.setMinimap = viewer.setMinimap;

  this.importXML = function(xml, bpmnDiagramId) {
    return viewer.importXML(xml, bpmnDiagramId).then(result => {
      commands.clear();
      hideBendpoints();
      bendpointGroup = null;
      destroyContextPad();
      destroyReplaceMenu();
      destroyConnectHandle();
      // wire modeling listeners after the graph is rendered
      attachModeling();
      return result;
    });
  };

  this.destroy = function() {
    detachModeling();
    if (palette && palette.parentNode) palette.parentNode.removeChild(palette);
    viewer.destroy();
  };

  // Shared modeling helpers ///////
  function getEdgesConnectedTo(node) {
    const graph = viewer.getGraph();
    if (!graph) return [];
    return graph.edges.filter(e => e.source === node || e.target === node);
  }

  function syncEdgeDi(edge) {
    if (edge.di) {
      edge.di.waypoint = edge.waypoints.map(p => moddle.create('dc:Point', { x: p.x, y: p.y }));
    }
  }

  // Bendpoint overlay //////////////
  // When a single connection is selected, render small grab handles at
  // every waypoint. Drag a handle to move that waypoint; mousedown on
  // the connection's line (not on a handle) inserts a new waypoint at
  // the click point and starts dragging it.

  let bendpointEdge = null;
  let bendpointHandles = [];
  let bendpointGroup = null;
  let bendDragState = null;

  function ensureBendpointGroup() {
    if (bendpointGroup) return bendpointGroup;
    bendpointGroup = svgCreate('g', { 'class': 'bpmn-xyflow-bendpoints' });
    // stick it on top of everything inside the viewport so handles
    // pan/zoom with the diagram but always sit above shapes/edges
    svgAppend(internals.viewport, bendpointGroup);
    return bendpointGroup;
  }

  function showBendpoints(edge) {
    hideBendpoints();
    bendpointEdge = edge;
    const g = ensureBendpointGroup();
    edge.waypoints.forEach((wp, i) => {
      const handle = svgCreate('circle', {
        'class': 'bpmn-xyflow-bendpoint',
        cx: wp.x, cy: wp.y, r: 4,
        fill: 'white',
        stroke: '#1a73e8',
        'stroke-width': 1.5,
        // tag with the parent edge so viewer.selection treats a click
        // on the handle as a click on the edge (keeps the edge selected
        // and prevents the handles from being hidden between clicks)
        'data-element-id': edge.id,
        'data-bend-index': String(i)
      });
      handle.style.cursor = 'move';
      svgAppend(g, handle);
      bendpointHandles.push(handle);
    });
  }

  function hideBendpoints() {
    bendpointHandles.forEach(h => h.parentNode && h.parentNode.removeChild(h));
    bendpointHandles = [];
    bendpointEdge = null;
  }

  function refreshBendpoints() {
    if (!bendpointEdge) return;
    // if the waypoint count changed, re-render
    if (bendpointHandles.length !== bendpointEdge.waypoints.length) {
      showBendpoints(bendpointEdge);
      return;
    }
    bendpointHandles.forEach((h, i) => {
      h.setAttribute('cx', bendpointEdge.waypoints[i].x);
      h.setAttribute('cy', bendpointEdge.waypoints[i].y);
    });
  }

  // perpendicular distance from p to segment ab (graph coords)
  function pointToSegmentDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function startBendDrag(edge, wpIndex, originalWaypoints, inserted) {
    bendDragState = {
      edge,
      wpIndex,
      originalWaypoints, // the waypoints array prior to this drag (for undo)
      inserted,          // true if we inserted a fresh waypoint at drag start
      moved: false
    };
  }

  function updateBendDrag(p) {
    if (!bendDragState) return;
    const { edge, wpIndex } = bendDragState;
    const wp = edge.waypoints[wpIndex];
    if (wp.x === p.x && wp.y === p.y) return;
    edge.waypoints[wpIndex] = { x: p.x, y: p.y };
    bendDragState.moved = true;
    syncEdgeDi(edge);
    internals.redrawConnection(edge);
    refreshBendpoints();
  }

  // Segment perpendicular drag /////
  let segmentDragState = null;

  function startSegmentDrag(edge, segIdx, startPoint) {
    // segment from waypoints[segIdx] to waypoints[segIdx+1]
    const a = edge.waypoints[segIdx];
    const b = edge.waypoints[segIdx + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return; // degenerate

    // perpendicular unit vector (rotate dir by 90°)
    const perp = { x: -dy / len, y: dx / len };

    // which endpoints actually move? docked source/target stay put; their
    // counterpart slides. For middle segments both slide.
    const lastIdx = edge.waypoints.length - 1;
    const moveStart = segIdx !== 0;
    const moveEnd = segIdx + 1 !== lastIdx;
    if (!moveStart && !moveEnd) return; // nothing to move (2-pt edge whole line)

    segmentDragState = {
      edge, segIdx, perp, startPoint,
      originalWaypoints: edge.waypoints.slice(),
      moveStart, moveEnd, moved: false
    };
  }

  function updateSegmentDrag(p) {
    if (!segmentDragState) return;
    const { edge, segIdx, perp, startPoint, originalWaypoints, moveStart, moveEnd } = segmentDragState;
    const dx = p.x - startPoint.x, dy = p.y - startPoint.y;
    // project onto perpendicular
    const proj = dx * perp.x + dy * perp.y;
    const offset = { x: perp.x * proj, y: perp.y * proj };

    const next = originalWaypoints.slice();
    if (moveStart) {
      const a = originalWaypoints[segIdx];
      next[segIdx] = { x: Math.round(a.x + offset.x), y: Math.round(a.y + offset.y) };
    }
    if (moveEnd) {
      const b = originalWaypoints[segIdx + 1];
      next[segIdx + 1] = { x: Math.round(b.x + offset.x), y: Math.round(b.y + offset.y) };
    }
    if (next[segIdx].x === edge.waypoints[segIdx].x &&
        next[segIdx].y === edge.waypoints[segIdx].y &&
        next[segIdx + 1].x === edge.waypoints[segIdx + 1].x &&
        next[segIdx + 1].y === edge.waypoints[segIdx + 1].y) return;

    edge.waypoints = next;
    syncEdgeDi(edge);
    internals.redrawConnection(edge);
    refreshBendpoints();
    segmentDragState.moved = true;
  }

  function endSegmentDrag() {
    if (!segmentDragState) return;
    const { edge, originalWaypoints, moved } = segmentDragState;
    segmentDragState = null;
    if (!moved) return;
    const finalWaypoints = edge.waypoints.slice();
    commands.execute({
      name: 'segment-move',
      do: () => {
        edge.waypoints = finalWaypoints.slice();
        syncEdgeDi(edge);
        internals.redrawConnection(edge);
        refreshBendpoints();
      },
      undo: () => {
        edge.waypoints = originalWaypoints.slice();
        syncEdgeDi(edge);
        internals.redrawConnection(edge);
        refreshBendpoints();
      }
    });
  }

  function endBendDrag() {
    if (!bendDragState) return;
    const { edge, originalWaypoints, moved, inserted } = bendDragState;
    bendDragState = null;
    if (!moved && !inserted) return;
    const finalWaypoints = edge.waypoints.slice();
    commands.execute({
      name: inserted ? 'insert-bendpoint' : 'move-bendpoint',
      do: () => {
        edge.waypoints = finalWaypoints.slice();
        syncEdgeDi(edge);
        internals.redrawConnection(edge);
        refreshBendpoints();
      },
      undo: () => {
        edge.waypoints = originalWaypoints.slice();
        syncEdgeDi(edge);
        internals.redrawConnection(edge);
        refreshBendpoints();
      }
    });
  }

  // Context pad ////////////////////
  // Floating action menu rendered next to a selected element. Mirrors
  // bpmn-js's signature UI: delete, append-task, connect, change-type.

  let contextPad = null;

  function destroyContextPad() {
    if (contextPad && contextPad.parentNode) contextPad.parentNode.removeChild(contextPad);
    contextPad = null;
  }

  function makePadButton(label, title, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    Object.assign(b.style, {
      width: '24px', height: '24px',
      border: '1px solid #ddd', background: 'white', borderRadius: '3px',
      cursor: 'pointer', font: '13px/1 -apple-system, BlinkMacSystemFont, sans-serif',
      padding: '0', display: 'flex', alignItems: 'center', justifyContent: 'center'
    });
    b.addEventListener('mouseenter', () => { b.style.background = '#f0f7ff'; b.style.borderColor = '#1a73e8'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'white'; b.style.borderColor = '#ddd'; });
    b.addEventListener('mousedown', e => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    return b;
  }

  function showContextPad(element) {
    destroyContextPad();
    if (!element || element.waypoints) return; // pad shows on shapes only

    const container = viewer.getContainer();
    const containerRect = container.getBoundingClientRect();
    const gfx = internals.elementGfx(element.id);
    if (!gfx) return;
    const elRect = gfx.getBoundingClientRect();

    contextPad = document.createElement('div');
    contextPad.className = 'bpmn-xyflow-context-pad';
    Object.assign(contextPad.style, {
      position: 'absolute',
      left: (elRect.right - containerRect.left + 6) + 'px',
      top: (elRect.top - containerRect.top - 6) + 'px',
      display: 'grid',
      gridTemplateColumns: 'repeat(2, auto)',
      gap: '4px',
      padding: '4px',
      background: 'rgba(255, 255, 255, 0.97)',
      border: '1px solid rgba(0, 0, 0, 0.1)',
      borderRadius: '4px',
      boxShadow: '0 2px 6px rgba(0, 0, 0, 0.08)',
      zIndex: 6
    });

    contextPad.appendChild(makePadButton('×', 'Delete', () => {
      deleteElement(element);
      destroyContextPad();
    }));

    contextPad.appendChild(makePadButton('→', 'Connect — drag to a target shape', (e) => {
      // start a connect gesture; user drags from the pad button
      destroyContextPad();
      const r = container.getBoundingClientRect();
      const p = internals.toGraph(e.clientX, e.clientY);
      startConnect(element, p.x, p.y);
      // attach a one-off mousemove/up to finish the connect
      function move(ev) {
        const q = internals.toGraph(ev.clientX, ev.clientY);
        updateConnectPreview(q.x, q.y);
      }
      function up(ev) {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
        const target = elementAtPoint(ev.clientX, ev.clientY);
        endConnect(target && !target.waypoints ? target : null);
      }
      window.addEventListener('mousemove', move, true);
      window.addEventListener('mouseup', up, true);
    }));

    contextPad.appendChild(makePadButton('▭', 'Append Task', () => {
      const newNode = addShape('bpmn:Task', { x: element.x + element.width + 80, y: element.y + element.height / 2 });
      if (newNode) {
        createSequenceFlow(element, newNode);
        viewer.select(newNode.id);
      }
    }));

    contextPad.appendChild(makePadButton('⇆', 'Change type — opens a quick replace menu', (e) => {
      openReplaceMenu(element, e.clientX, e.clientY);
    }));

    container.appendChild(contextPad);
  }

  function repositionContextPad() {
    if (!contextPad) return;
    const ids = viewer.getSelection();
    if (ids.length !== 1) return;
    const el = viewer.getElement(ids[0]);
    if (el) showContextPad(el);
  }

  // Replace menu ///////////////////
  let replaceMenu = null;

  function destroyReplaceMenu() {
    if (replaceMenu && replaceMenu.parentNode) replaceMenu.parentNode.removeChild(replaceMenu);
    replaceMenu = null;
  }

  function replaceCandidatesFor(type) {
    if (/Task|Activity|CallActivity|SubProcess/.test(type)) {
      return [
        [ 'bpmn:Task', 'Task' ],
        [ 'bpmn:UserTask', 'User Task' ],
        [ 'bpmn:ServiceTask', 'Service Task' ],
        [ 'bpmn:ScriptTask', 'Script Task' ],
        [ 'bpmn:BusinessRuleTask', 'Business Rule' ],
        [ 'bpmn:SendTask', 'Send Task' ],
        [ 'bpmn:ReceiveTask', 'Receive Task' ],
        [ 'bpmn:ManualTask', 'Manual Task' ]
      ];
    }
    if (/Gateway/.test(type)) {
      return [
        [ 'bpmn:ExclusiveGateway', 'Exclusive (XOR)' ],
        [ 'bpmn:ParallelGateway', 'Parallel (AND)' ],
        [ 'bpmn:InclusiveGateway', 'Inclusive (OR)' ],
        [ 'bpmn:EventBasedGateway', 'Event-Based' ],
        [ 'bpmn:ComplexGateway', 'Complex' ]
      ];
    }
    if (/Event/.test(type)) {
      // keep the throw/catch role; allow event family swaps
      const isEnd = type === 'bpmn:EndEvent';
      const isThrow = type === 'bpmn:IntermediateThrowEvent' || isEnd;
      return [
        [ 'bpmn:StartEvent', 'Start' ],
        [ 'bpmn:IntermediateCatchEvent', 'Intermediate Catch' ],
        [ 'bpmn:IntermediateThrowEvent', 'Intermediate Throw' ],
        [ 'bpmn:EndEvent', 'End' ]
      ].filter(([ t ]) => t !== type);
    }
    return [];
  }

  function openReplaceMenu(element, clientX, clientY) {
    destroyReplaceMenu();
    const items = replaceCandidatesFor(element.type);
    if (!items.length) return;

    const container = viewer.getContainer();
    const containerRect = container.getBoundingClientRect();

    replaceMenu = document.createElement('div');
    replaceMenu.className = 'bpmn-xyflow-replace-menu';
    Object.assign(replaceMenu.style, {
      position: 'absolute',
      left: (clientX - containerRect.left) + 'px',
      top: (clientY - containerRect.top + 8) + 'px',
      background: 'white',
      border: '1px solid rgba(0, 0, 0, 0.15)',
      borderRadius: '4px',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.12)',
      padding: '4px 0',
      minWidth: '160px',
      zIndex: 8,
      font: '12px -apple-system, BlinkMacSystemFont, sans-serif'
    });

    items.forEach(([ type, label ]) => {
      const item = document.createElement('div');
      item.textContent = label;
      Object.assign(item.style, {
        padding: '6px 12px', cursor: 'pointer', whiteSpace: 'nowrap'
      });
      item.addEventListener('mouseenter', () => { item.style.background = '#f0f7ff'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'white'; });
      item.addEventListener('mousedown', e => e.stopPropagation());
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        replaceShape(element, type);
        destroyReplaceMenu();
        repositionContextPad();
      });
      replaceMenu.appendChild(item);
    });

    container.appendChild(replaceMenu);

    // dismiss on outside click
    setTimeout(() => {
      const off = (ev) => {
        if (replaceMenu && !replaceMenu.contains(ev.target)) {
          destroyReplaceMenu();
          window.removeEventListener('mousedown', off, true);
        }
      };
      window.addEventListener('mousedown', off, true);
    }, 0);
  }

  // Rubber-band selection //////////
  // Drag from empty canvas (no shape under cursor) → draws a marquee
  // rectangle and selects every shape that intersects it on release.

  let lassoState = null;
  let lassoRect = null;

  function startLasso(graphPoint) {
    lassoState = { start: graphPoint, current: graphPoint };
    lassoRect = svgCreate('rect', {
      'class': 'bpmn-xyflow-lasso',
      x: graphPoint.x, y: graphPoint.y, width: 0, height: 0,
      fill: 'rgba(26, 115, 232, 0.08)',
      stroke: '#1a73e8',
      'stroke-width': 1,
      'stroke-dasharray': '4,3',
      'pointer-events': 'none'
    });
    svgAppend(internals.viewport, lassoRect);
  }

  function updateLasso(graphPoint) {
    if (!lassoState) return;
    lassoState.current = graphPoint;
    const a = lassoState.start, b = graphPoint;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    lassoRect.setAttribute('x', x);
    lassoRect.setAttribute('y', y);
    lassoRect.setAttribute('width', w);
    lassoRect.setAttribute('height', h);
  }

  function endLasso(additive) {
    if (!lassoState) return;
    const a = lassoState.start, b = lassoState.current;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (lassoRect && lassoRect.parentNode) lassoRect.parentNode.removeChild(lassoRect);
    lassoRect = null;
    lassoState = null;

    if (w < 3 && h < 3) {
      // tiny lasso → treat as plain canvas click
      if (!additive) viewer.clearSelection();
      return;
    }

    const graph = viewer.getGraph();
    if (!graph) return;
    const lasso = { x, y, width: w, height: h };
    const hit = graph.nodes.filter(n =>
      !n.waypoints && !n.hidden && n.type !== 'label' &&
      n.x !== undefined &&
      n.x + n.width >= lasso.x &&
      n.x <= lasso.x + lasso.width &&
      n.y + n.height >= lasso.y &&
      n.y <= lasso.y + lasso.height
    ).map(n => n.id);

    if (additive) {
      const cur = new Set(viewer.getSelection());
      hit.forEach(id => cur.add(id));
      viewer.select([ ...cur ]);
    } else {
      viewer.select(hit);
    }
  }

  // Resize handles /////////////////
  let resizeHandles = [];
  let resizeGroup = null;
  let resizeDragState = null;

  const RESIZE_DIRS = [
    { id: 'nw', x: 0, y: 0, cursor: 'nwse-resize' },
    { id: 'n',  x: 0.5, y: 0, cursor: 'ns-resize' },
    { id: 'ne', x: 1, y: 0, cursor: 'nesw-resize' },
    { id: 'e',  x: 1, y: 0.5, cursor: 'ew-resize' },
    { id: 'se', x: 1, y: 1, cursor: 'nwse-resize' },
    { id: 's',  x: 0.5, y: 1, cursor: 'ns-resize' },
    { id: 'sw', x: 0, y: 1, cursor: 'nesw-resize' },
    { id: 'w',  x: 0, y: 0.5, cursor: 'ew-resize' }
  ];

  function showResizeHandles(node) {
    hideResizeHandles();
    if (!node || node.waypoints || node.type === 'label') return;
    if (node.type === 'bpmn:Lane' || node.type === 'bpmn:Participant') {
      // skip lanes/pools — they have child semantics we don't model yet
    }

    resizeGroup = svgCreate('g', { 'class': 'bpmn-xyflow-resize-handles' });
    svgAppend(internals.viewport, resizeGroup);

    RESIZE_DIRS.forEach(dir => {
      const cx = node.x + node.width * dir.x;
      const cy = node.y + node.height * dir.y;
      const r = svgCreate('rect', {
        'class': 'bpmn-xyflow-resize-handle',
        'data-resize-dir': dir.id,
        x: cx - 4, y: cy - 4, width: 8, height: 8,
        fill: 'white', stroke: '#1a73e8', 'stroke-width': 1.5
      });
      r.style.cursor = dir.cursor;
      svgAppend(resizeGroup, r);
      resizeHandles.push({ gfx: r, dir });
    });
  }

  function hideResizeHandles() {
    if (resizeGroup && resizeGroup.parentNode) resizeGroup.parentNode.removeChild(resizeGroup);
    resizeGroup = null;
    resizeHandles = [];
  }

  function refreshResizeHandles() {
    if (!resizeGroup) return;
    const ids = viewer.getSelection();
    if (ids.length !== 1) return;
    const node = viewer.getElement(ids[0]);
    if (!node) return;
    resizeHandles.forEach(({ gfx, dir }) => {
      const cx = node.x + node.width * dir.x;
      const cy = node.y + node.height * dir.y;
      gfx.setAttribute('x', cx - 4);
      gfx.setAttribute('y', cy - 4);
    });
  }

  function startResize(node, dir, evt) {
    const p = internals.toGraph(evt.clientX, evt.clientY);

    // Capture every connected edge's docked-endpoint relative position
    // ONCE, against the drag-start bounds. Every tick of the resize
    // re-derives the new endpoint from this fixed rel position, so
    // resizing the shape out and back to its original size returns the
    // anchor to its exact original coordinates (no per-tick drift, no
    // re-crop).
    const edges = getEdgesConnectedTo(node);
    const anchors = edges.map(edge => {
      const sourceIs = edge.source === node;
      const targetIs = edge.target === node;
      const safeRel = wp => ({
        rx: node.width === 0 ? 0 : (wp.x - node.x) / node.width,
        ry: node.height === 0 ? 0 : (wp.y - node.y) / node.height
      });
      return {
        edge,
        originalWaypoints: edge.waypoints.slice(),
        sourceRel: sourceIs ? safeRel(edge.waypoints[0]) : null,
        targetRel: targetIs ? safeRel(edge.waypoints[edge.waypoints.length - 1]) : null
      };
    });

    resizeDragState = {
      node, dir,
      origin: { x: node.x, y: node.y, w: node.width, h: node.height },
      start: p,
      anchors,
      moved: false
    };
  }

  function updateResize(evt) {
    if (!resizeDragState) return;
    const { node, dir, origin, start } = resizeDragState;
    const p = internals.toGraph(evt.clientX, evt.clientY);
    let dx = p.x - start.x, dy = p.y - start.y;

    let nx = origin.x, ny = origin.y, nw = origin.w, nh = origin.h;

    if (dir.id.includes('w')) {
      nx = origin.x + dx; nw = origin.w - dx;
    } else if (dir.id.includes('e')) {
      nw = origin.w + dx;
    }
    if (dir.id.includes('n')) {
      ny = origin.y + dy; nh = origin.h - dy;
    } else if (dir.id.includes('s')) {
      nh = origin.h + dy;
    }

    const minSize = 20;
    if (nw < minSize) {
      if (dir.id.includes('w')) nx -= (minSize - nw);
      nw = minSize;
    }
    if (nh < minSize) {
      if (dir.id.includes('n')) ny -= (minSize - nh);
      nh = minSize;
    }

    nx = Math.round(nx); ny = Math.round(ny); nw = Math.round(nw); nh = Math.round(nh);
    if (nx === node.x && ny === node.y && nw === node.width && nh === node.height) return;

    applyResize(node, nx, ny, nw, nh, resizeDragState.anchors);
    resizeDragState.moved = true;
  }

  /**
   * Apply new bounds to `node` and reposition every docked edge endpoint.
   *
   * Endpoints are placed using their drag-start relative positions
   * (`anchors`), which makes the gesture exactly reversible: resizing
   * out and back to the original size returns each anchor to its
   * original coordinates with no floating-point drift.
   *
   * If `anchors` is omitted (e.g. an undo from outside the drag),
   * we fall back to capturing rel positions from the current bounds.
   */
  function applyResize(node, x, y, w, h, anchors) {
    if (!anchors) {
      const edges = getEdgesConnectedTo(node);
      anchors = edges.map(edge => {
        const safeRel = wp => ({
          rx: node.width === 0 ? 0 : (wp.x - node.x) / node.width,
          ry: node.height === 0 ? 0 : (wp.y - node.y) / node.height
        });
        return {
          edge,
          originalWaypoints: edge.waypoints.slice(),
          sourceRel: edge.source === node ? safeRel(edge.waypoints[0]) : null,
          targetRel: edge.target === node ? safeRel(edge.waypoints[edge.waypoints.length - 1]) : null
        };
      });
    }

    node.x = x; node.y = y; node.width = w; node.height = h;
    if (node.di && node.di.bounds) {
      node.di.bounds.x = x; node.di.bounds.y = y;
      node.di.bounds.width = w; node.di.bounds.height = h;
    }
    internals.redrawShape(node);

    anchors.forEach(({ edge, sourceRel, targetRel }) => {
      if (sourceRel) {
        edge.waypoints[0] = { x: x + sourceRel.rx * w, y: y + sourceRel.ry * h };
      }
      if (targetRel) {
        const i = edge.waypoints.length - 1;
        edge.waypoints[i] = { x: x + targetRel.rx * w, y: y + targetRel.ry * h };
      }
      syncEdgeDi(edge);
      internals.redrawConnection(edge);
      if (bendpointEdge === edge) refreshBendpoints();
    });

    refreshResizeHandles();
    repositionContextPad();
  }

  function endResize() {
    if (!resizeDragState) return;
    const { node, origin, anchors, moved } = resizeDragState;
    resizeDragState = null;
    if (!moved) return;

    const final = { x: node.x, y: node.y, w: node.width, h: node.height };
    // freeze the absolute waypoints at end-of-drag so do/undo restore
    // them exactly, with no further floating-point recalculation
    const finalWaypoints = anchors.map(a => ({ edge: a.edge, wp: a.edge.waypoints.slice() }));

    commands.execute({
      name: 'resize',
      do: () => {
        node.x = final.x; node.y = final.y;
        node.width = final.w; node.height = final.h;
        if (node.di && node.di.bounds) {
          node.di.bounds.x = final.x; node.di.bounds.y = final.y;
          node.di.bounds.width = final.w; node.di.bounds.height = final.h;
        }
        internals.redrawShape(node);
        finalWaypoints.forEach(({ edge, wp }) => {
          edge.waypoints = wp.slice();
          syncEdgeDi(edge);
          internals.redrawConnection(edge);
          if (bendpointEdge === edge) refreshBendpoints();
        });
        refreshResizeHandles();
        repositionContextPad();
      },
      undo: () => {
        node.x = origin.x; node.y = origin.y;
        node.width = origin.w; node.height = origin.h;
        if (node.di && node.di.bounds) {
          node.di.bounds.x = origin.x; node.di.bounds.y = origin.y;
          node.di.bounds.width = origin.w; node.di.bounds.height = origin.h;
        }
        internals.redrawShape(node);
        anchors.forEach(({ edge, originalWaypoints }) => {
          edge.waypoints = originalWaypoints.slice();
          syncEdgeDi(edge);
          internals.redrawConnection(edge);
          if (bendpointEdge === edge) refreshBendpoints();
        });
        refreshResizeHandles();
        repositionContextPad();
      }
    });
  }

  // Hover connect handle //////////
  // Bpmn.io shows a small drag-handle on shape hover so users can pull
  // a connection out of a shape without learning the shift+drag idiom.

  let connectHandle = null;
  let hoveredForConnect = null;

  function destroyConnectHandle() {
    if (connectHandle && connectHandle.parentNode) connectHandle.parentNode.removeChild(connectHandle);
    connectHandle = null;
    hoveredForConnect = null;
  }

  function showConnectHandle(node) {
    if (!node || node.waypoints || node.type === 'label') return;
    if (hoveredForConnect === node && connectHandle) return;
    destroyConnectHandle();
    hoveredForConnect = node;

    const handle = svgCreate('g', { 'class': 'bpmn-xyflow-connect-handle' });
    const cx = node.x + node.width;
    const cy = node.y + node.height / 2;
    const circle = svgCreate('circle', {
      cx, cy, r: 5,
      fill: '#1a73e8',
      stroke: 'white',
      'stroke-width': 1.5
    });
    circle.style.cursor = 'crosshair';
    svgAppend(handle, circle);
    svgAppend(internals.viewport, handle);
    connectHandle = handle;

    handle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const p = internals.toGraph(e.clientX, e.clientY);
      startConnect(node, p.x, p.y);
      destroyConnectHandle();
      function move(ev) {
        const q = internals.toGraph(ev.clientX, ev.clientY);
        updateConnectPreview(q.x, q.y);
      }
      function up(ev) {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
        const target = elementAtPoint(ev.clientX, ev.clientY);
        endConnect(target && !target.waypoints ? target : null);
      }
      window.addEventListener('mousemove', move, true);
      window.addEventListener('mouseup', up, true);
    });
  }

  viewer.on('element.hover', ({ element }) => {
    if (element && !element.waypoints && element.type !== 'label' && !dragState && !connectState) {
      showConnectHandle(element);
    }
  });
  viewer.on('element.out', () => {
    // small delay so the cursor can move onto the handle itself
    setTimeout(() => {
      if (!connectHandle) return;
      // only destroy if we're not hovering the handle's gfx
      if (!connectHandle.matches(':hover')) destroyConnectHandle();
    }, 80);
  });

  // wire show/hide to selection
  viewer.on('selection.change', ({ ids }) => {
    destroyContextPad();
    destroyReplaceMenu();
    hideResizeHandles();
    if (ids.length === 1) {
      const el = viewer.getElement(ids[0]);
      if (el && el.waypoints) {
        showBendpoints(el);
        return;
      }
      if (el) {
        hideBendpoints();
        showContextPad(el);
        showResizeHandles(el);
        return;
      }
    }
    hideBendpoints();
  });

  // re-position the pad when the user pans/zooms or the shape moves
  viewer.on('viewport.change', () => repositionContextPad());

  // Right-click context menu //////
  let rightClickMenu = null;

  function destroyRightClickMenu() {
    if (rightClickMenu && rightClickMenu.parentNode) rightClickMenu.parentNode.removeChild(rightClickMenu);
    rightClickMenu = null;
  }

  function openRightClickMenu(items, clientX, clientY) {
    destroyRightClickMenu();
    if (!items.length) return;

    const container = viewer.getContainer();
    const containerRect = container.getBoundingClientRect();

    rightClickMenu = document.createElement('div');
    rightClickMenu.className = 'bpmn-xyflow-context-menu';
    Object.assign(rightClickMenu.style, {
      position: 'absolute',
      left: (clientX - containerRect.left) + 'px',
      top: (clientY - containerRect.top) + 'px',
      background: 'white',
      border: '1px solid rgba(0, 0, 0, 0.15)',
      borderRadius: '4px',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.12)',
      padding: '4px 0',
      minWidth: '160px',
      zIndex: 9,
      font: '12px -apple-system, BlinkMacSystemFont, sans-serif'
    });

    items.forEach(item => {
      if (item.divider) {
        const d = document.createElement('div');
        Object.assign(d.style, { height: '1px', background: '#eee', margin: '4px 0' });
        rightClickMenu.appendChild(d);
        return;
      }
      const row = document.createElement('div');
      row.textContent = item.label;
      Object.assign(row.style, {
        padding: '6px 12px', cursor: 'pointer', whiteSpace: 'nowrap',
        opacity: item.disabled ? '0.5' : '1'
      });
      if (!item.disabled) {
        row.addEventListener('mouseenter', () => { row.style.background = '#f0f7ff'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'white'; });
        row.addEventListener('mousedown', e => e.stopPropagation());
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          destroyRightClickMenu();
          item.action();
        });
      }
      rightClickMenu.appendChild(row);
    });

    container.appendChild(rightClickMenu);

    // dismiss on outside click
    setTimeout(() => {
      const off = (ev) => {
        if (rightClickMenu && !rightClickMenu.contains(ev.target)) {
          destroyRightClickMenu();
          window.removeEventListener('mousedown', off, true);
        }
      };
      window.addEventListener('mousedown', off, true);
    }, 0);
  }

  function onContextMenu(evt) {
    evt.preventDefault();
    const id = internals.findElementId(evt.target);
    const el = id ? viewer.getElement(id) : null;

    if (!el) {
      openRightClickMenu([
        { label: 'Paste', disabled: !clipboard, action: () => pasteAtPoint(evt.clientX, evt.clientY) },
        { divider: true },
        { label: 'Fit view', action: () => viewer.fitView() },
        { label: 'Reset zoom', action: () => viewer.setViewport({ x: 0, y: 0, zoom: 1 }) }
      ], evt.clientX, evt.clientY);
      return;
    }

    const isEdge = !!el.waypoints;
    const items = [];

    if (!isEdge) {
      items.push({ label: 'Rename…', action: () => openLabelEditor(el, null) });
      items.push({ label: 'Append Task', action: () => {
        const n = addShape('bpmn:Task', { x: el.x + el.width + 80, y: el.y + el.height / 2 });
        if (n) { createSequenceFlow(el, n); viewer.select(n.id); }
      } });
      items.push({ label: 'Change type…', action: () => openReplaceMenu(el, evt.clientX, evt.clientY) });
      items.push({ divider: true });
      items.push({ label: 'Copy', action: () => copySelection() });
      items.push({ label: 'Paste', disabled: !clipboard, action: () => pasteAtPoint(evt.clientX, evt.clientY) });
      items.push({ divider: true });
    } else {
      items.push({ label: 'Change type…', action: () => openReplaceMenu(el, evt.clientX, evt.clientY) });
      items.push({ divider: true });
    }

    items.push({ label: 'Delete', action: () => { deleteElement(el); viewer.clearSelection(); } });

    if (!viewer.getSelection().includes(el.id)) viewer.select(el.id);
    openRightClickMenu(items, evt.clientX, evt.clientY);
  }

  /**
   * Move the docked endpoint(s) of `edge` by (dx, dy).
   *
   * Matches bpmn-js's behaviour: when a shape moves, only the
   * waypoint(s) attached to that shape translate; intermediate bends
   * stay put. This preserves orthogonal/manual routing across edits.
   */
  function shiftEdgeEndpoints(edge, movedNode, dx, dy) {
    if (edge.source === movedNode) {
      const wp = edge.waypoints[0];
      edge.waypoints[0] = { x: wp.x + dx, y: wp.y + dy };
    }
    if (edge.target === movedNode) {
      const i = edge.waypoints.length - 1;
      const wp = edge.waypoints[i];
      edge.waypoints[i] = { x: wp.x + dx, y: wp.y + dy };
    }
    // re-crop the docked endpoints against the moved shape's path
    const bpmnRenderer = internals.renderer && internals.renderer.bpmnRenderer;
    if (bpmnRenderer) {
      edge.waypoints = cropWaypoints(edge.waypoints, edge.source, edge.target, bpmnRenderer);
    }
    syncEdgeDi(edge);
    internals.redrawConnection(edge);
    if (bendpointEdge === edge) refreshBendpoints();
  }

  function setNodePosition(node, x, y) {
    const dx = x - node.x;
    const dy = y - node.y;
    if (dx === 0 && dy === 0) return;

    node.x = x;
    node.y = y;
    if (node.di && node.di.bounds) {
      node.di.bounds.x = x;
      node.di.bounds.y = y;
    }

    // re-position the existing gfx without re-rendering
    const gfx = internals.elementGfx(node.id);
    if (gfx) gfx.setAttribute('transform', `translate(${ x }, ${ y })`);

    // shift connected-edge endpoints by the same delta — preserve bends
    getEdgesConnectedTo(node).forEach(edge => shiftEdgeEndpoints(edge, node, dx, dy));

    internals.refreshSelection();
    repositionContextPad();
    refreshResizeHandles();
  }

  function findRootContainer() {
    const graph = viewer.getGraph();
    return graph && (graph.roots[0] || null);
  }

  function findOwningProcess() {
    const defs = viewer.getDefinitions();
    if (!defs) return null;

    // Prefer a Collaboration's first participant's processRef, else first Process
    for (const root of defs.rootElements || []) {
      if (root.$type === 'bpmn:Collaboration') {
        const p = (root.participants || []).find(x => x.processRef);
        if (p) return p.processRef;
      }
    }
    return (defs.rootElements || []).find(r => r.$type === 'bpmn:Process') || null;
  }

  // Move ///////////////////////////
  // We listen to mousedown (the same event d3-zoom hooks via XYPanZoom).
  // A capture-phase stopPropagation on mousedown is the only way to win
  // the gesture from d3-zoom; pointerdown alone is not enough because
  // browsers dispatch a parallel mousedown that d3-zoom would still see.
  let dragState = null;

  function onMouseDown(evt) {
    if (evt.button !== 0) return;
    if (connectState || dragState || bendDragState || resizeDragState || segmentDragState) return;

    // 0. handle click on a resize handle → start resize
    if (evt.target && evt.target.classList && evt.target.classList.contains('bpmn-xyflow-resize-handle')) {
      const ids = viewer.getSelection();
      if (ids.length === 1) {
        const node = viewer.getElement(ids[0]);
        const dir = RESIZE_DIRS.find(d => d.id === evt.target.getAttribute('data-resize-dir'));
        if (node && dir) {
          startResize(node, dir, evt);
          evt.stopPropagation();
          evt.preventDefault();
          return;
        }
      }
    }

    // 1. handle click on a bendpoint handle → drag waypoint
    if (evt.target && evt.target.classList && evt.target.classList.contains('bpmn-xyflow-bendpoint')) {
      const idx = Number(evt.target.getAttribute('data-bend-index'));
      if (bendpointEdge && Number.isFinite(idx)) {
        startBendDrag(bendpointEdge, idx, bendpointEdge.waypoints.slice(), false);
        evt.stopPropagation();
        evt.preventDefault();
        return;
      }
    }

    const id = internals.findElementId(evt.target);
    const el = id ? viewer.getElement(id) : null;
    if (!el) {
      // empty canvas: shift+drag → lasso; plain drag falls through to panZoom
      if (evt.shiftKey) {
        const p = internals.toGraph(evt.clientX, evt.clientY);
        startLasso(p);
        evt.stopPropagation();
        evt.preventDefault();
      }
      return;
    }
    if (el.type === 'label') return;

    // 2. mousedown on a selected connection's line:
    //    - alt+drag  → insert a new free-form bendpoint at click, drag it
    //    - plain drag → perpendicular segment slide (matches bpmn-js)
    if (el.waypoints) {
      if (bendpointEdge !== el) return;
      const p = internals.toGraph(evt.clientX, evt.clientY);

      // find the nearest segment
      let bestIdx = 1, bestDist = Infinity;
      for (let i = 0; i < el.waypoints.length - 1; i++) {
        const d = pointToSegmentDist(p, el.waypoints[i], el.waypoints[i + 1]);
        if (d < bestDist) { bestDist = d; bestIdx = i + 1; }
      }

      if (evt.altKey) {
        const original = el.waypoints.slice();
        el.waypoints.splice(bestIdx, 0, { x: p.x, y: p.y });
        syncEdgeDi(el);
        internals.redrawConnection(el);
        refreshBendpoints();
        startBendDrag(el, bestIdx, original, true);
      } else {
        startSegmentDrag(el, bestIdx - 1, p);
      }

      evt.stopPropagation();
      evt.preventDefault();
      return;
    }

    // 3. shape mousedown
    if (!('x' in el)) return;
    const p = internals.toGraph(evt.clientX, evt.clientY);

    if (evt.shiftKey) {
      startConnect(el, p.x, p.y);
      evt.stopPropagation();
      evt.preventDefault();
      return;
    }

    // when multiple shapes are selected and the user grabs one of them,
    // drag the whole group; if they grabbed an unselected shape, drag
    // just that one (and pin selection to it on mouseup)
    const selected = viewer.getSelection();
    const draggedNodes = selected.includes(el.id)
      ? selected.map(i => viewer.getElement(i)).filter(n => n && !n.waypoints && 'x' in n)
      : [ el ];

    dragState = {
      nodes: draggedNodes,
      origins: draggedNodes.map(n => ({ x: n.x, y: n.y })),
      anchor: el,
      offset: { x: p.x - el.x, y: p.y - el.y },
      moved: false
    };

    evt.stopPropagation();
    evt.preventDefault();
  }

  function onMouseMove(evt) {
    if (connectState) {
      const p = internals.toGraph(evt.clientX, evt.clientY);
      updateConnectPreview(p.x, p.y);
      return;
    }
    if (bendDragState) {
      const p = internals.toGraph(evt.clientX, evt.clientY);
      updateBendDrag({ x: Math.round(p.x), y: Math.round(p.y) });
      return;
    }
    if (segmentDragState) {
      const p = internals.toGraph(evt.clientX, evt.clientY);
      updateSegmentDrag(p);
      return;
    }
    if (resizeDragState) {
      updateResize(evt);
      return;
    }
    if (lassoState) {
      const p = internals.toGraph(evt.clientX, evt.clientY);
      updateLasso(p);
      return;
    }
    if (!dragState) return;
    const p = internals.toGraph(evt.clientX, evt.clientY);
    const anchor = dragState.anchor;
    const newAnchorX = Math.round(p.x - dragState.offset.x);
    const newAnchorY = Math.round(p.y - dragState.offset.y);
    const dx = newAnchorX - anchor.x;
    const dy = newAnchorY - anchor.y;
    if (dx === 0 && dy === 0) return;
    dragState.nodes.forEach(n => setNodePosition(n, n.x + dx, n.y + dy));
    dragState.moved = true;
  }

  function elementAtPoint(clientX, clientY) {
    const target = document.elementFromPoint(clientX, clientY);
    if (!target) return null;
    const id = internals.findElementId(target);
    return id ? viewer.getElement(id) : null;
  }

  function onMouseUp(evt) {
    if (connectState) {
      const node = elementAtPoint(evt.clientX, evt.clientY);
      endConnect(node && !node.waypoints ? node : null);
      return;
    }
    if (bendDragState) {
      endBendDrag();
      return;
    }
    if (segmentDragState) {
      endSegmentDrag();
      return;
    }
    if (resizeDragState) {
      endResize();
      return;
    }
    if (lassoState) {
      endLasso(evt.ctrlKey || evt.metaKey);
      return;
    }
    if (!dragState) return;
    const { nodes, origins, moved } = dragState;
    dragState = null;
    if (!moved) return;

    const finals = nodes.map(n => ({ x: n.x, y: n.y }));

    // capture old waypoints for every connected edge so undo restores exactly
    const edgeSet = new Set();
    nodes.forEach(n => getEdgesConnectedTo(n).forEach(e => edgeSet.add(e)));
    const oldWaypoints = new Map([ ...edgeSet ].map(e => [ e, e.waypoints.slice() ]));

    commands.execute({
      name: 'move',
      do: () => {
        nodes.forEach((n, i) => setNodePosition(n, finals[i].x, finals[i].y));
      },
      undo: () => {
        nodes.forEach((n, i) => setNodePosition(n, origins[i].x, origins[i].y));
        for (const [ edge, wp ] of oldWaypoints) {
          edge.waypoints = wp.slice();
          syncEdgeDi(edge);
          internals.redrawConnection(edge);
        }
      }
    });
  }

  // Connect ////////////////////////
  let connectState = null;

  // an SVG <g> living in viewport that previews the in-flight connection
  let connectPreview = null;

  function startConnect(node, x, y) {
    connectState = { source: node };
    connectPreview = svgCreate('g', { 'class': 'bpmn-xyflow-connect-preview' });
    const line = svgCreate('line', {
      x1: getMid(node).x, y1: getMid(node).y,
      x2: x, y2: y,
      stroke: '#1a73e8', 'stroke-width': 2, 'stroke-dasharray': '5,3', fill: 'none',
      'pointer-events': 'none'
    });
    svgAppend(connectPreview, line);
    svgAppend(internals.viewport, connectPreview);
  }

  function updateConnectPreview(x, y) {
    if (!connectPreview) return;
    const line = connectPreview.firstChild;
    line.setAttribute('x2', x);
    line.setAttribute('y2', y);
  }

  function endConnect(targetNode) {
    if (!connectState) return;
    const source = connectState.source;
    connectState = null;

    if (connectPreview && connectPreview.parentNode) {
      connectPreview.parentNode.removeChild(connectPreview);
    }
    connectPreview = null;

    if (!targetNode || targetNode === source) return;
    if (targetNode.type === 'label') return;

    createSequenceFlow(source, targetNode);
  }

  function createSequenceFlow(source, target) {
    const graph = viewer.getGraph();
    const defs = viewer.getDefinitions();
    if (!graph || !defs) return;

    const owningProcess = (source.businessObject.$parent && source.businessObject.$parent.$type === 'bpmn:Process')
      ? source.businessObject.$parent
      : findOwningProcess();
    if (!owningProcess) return;

    const id = nextId('SequenceFlow');

    const businessObject = moddle.create('bpmn:SequenceFlow', {
      id,
      sourceRef: source.businessObject,
      targetRef: target.businessObject
    });
    businessObject.$parent = owningProcess;
    owningProcess.flowElements = owningProcess.flowElements || [];
    owningProcess.flowElements.push(businessObject);

    // wire incoming/outgoing on FlowNode if they exist
    if (Array.isArray(source.businessObject.outgoing)) source.businessObject.outgoing.push(businessObject);
    if (Array.isArray(target.businessObject.incoming)) target.businessObject.incoming.push(businessObject);

    // start with mid-to-mid then crop to the real shape paths
    const initial = [ getMid(source), getMid(target) ];
    const bpmnRenderer = internals.renderer && internals.renderer.bpmnRenderer;
    const waypoints = bpmnRenderer
      ? cropWaypoints(initial, source, target, bpmnRenderer)
      : computeWaypoints(source, target);

    // BPMN DI for the edge, attached to the plane
    const plane = (defs.diagrams && defs.diagrams[0] && defs.diagrams[0].plane) || null;
    const di = moddle.create('bpmndi:BPMNEdge', {
      id: id + '_di',
      bpmnElement: businessObject,
      waypoint: waypoints.map(p => moddle.create('dc:Point', { x: p.x, y: p.y }))
    });
    if (plane) {
      plane.planeElement = plane.planeElement || [];
      plane.planeElement.push(di);
    }

    const edge = {
      id,
      type: 'bpmn:SequenceFlow',
      businessObject,
      di,
      source,
      target,
      waypoints,
      parent: source.parent,
      hidden: false
    };

    commands.execute({
      name: 'connect',
      do: () => {
        if (!graph.edges.includes(edge)) graph.edges.push(edge);
        graph.elementsById.set(edge.id, edge);
        if (!owningProcess.flowElements.includes(businessObject)) {
          owningProcess.flowElements.push(businessObject);
        }
        if (plane && !plane.planeElement.includes(di)) plane.planeElement.push(di);
        internals.redrawConnection(edge);
      },
      undo: () => {
        const idx = graph.edges.indexOf(edge);
        if (idx >= 0) graph.edges.splice(idx, 1);
        graph.elementsById.delete(edge.id);
        const fIdx = owningProcess.flowElements.indexOf(businessObject);
        if (fIdx >= 0) owningProcess.flowElements.splice(fIdx, 1);
        if (plane) {
          const dIdx = plane.planeElement.indexOf(di);
          if (dIdx >= 0) plane.planeElement.splice(dIdx, 1);
        }
        internals.removeElementGfx(edge.id);
      }
    });
  }

  // Delete /////////////////////////
  function deleteElement(element) {
    const graph = viewer.getGraph();
    const defs = viewer.getDefinitions();
    if (!graph || !defs) return;

    const isEdge = !!element.waypoints;

    if (isEdge) {
      const bo = element.businessObject;
      const owner = bo.$parent;
      const plane = (defs.diagrams && defs.diagrams[0] && defs.diagrams[0].plane) || null;

      const oldFlowIndex = owner && owner.flowElements ? owner.flowElements.indexOf(bo) : -1;
      const oldDiIndex = plane && plane.planeElement ? plane.planeElement.indexOf(element.di) : -1;
      const oldEdgesIndex = graph.edges.indexOf(element);
      const oldOutIndex = element.source.businessObject.outgoing ? element.source.businessObject.outgoing.indexOf(bo) : -1;
      const oldInIndex = element.target.businessObject.incoming ? element.target.businessObject.incoming.indexOf(bo) : -1;

      commands.execute({
        name: 'delete-edge',
        do: () => {
          if (oldFlowIndex >= 0) owner.flowElements.splice(owner.flowElements.indexOf(bo), 1);
          if (oldDiIndex >= 0) plane.planeElement.splice(plane.planeElement.indexOf(element.di), 1);
          if (oldEdgesIndex >= 0) graph.edges.splice(graph.edges.indexOf(element), 1);
          graph.elementsById.delete(element.id);
          if (oldOutIndex >= 0) element.source.businessObject.outgoing.splice(element.source.businessObject.outgoing.indexOf(bo), 1);
          if (oldInIndex >= 0) element.target.businessObject.incoming.splice(element.target.businessObject.incoming.indexOf(bo), 1);
          internals.removeElementGfx(element.id);
        },
        undo: () => {
          if (oldFlowIndex >= 0) owner.flowElements.splice(oldFlowIndex, 0, bo);
          if (plane && oldDiIndex >= 0) plane.planeElement.splice(oldDiIndex, 0, element.di);
          if (oldEdgesIndex >= 0) graph.edges.splice(oldEdgesIndex, 0, element);
          graph.elementsById.set(element.id, element);
          if (element.source.businessObject.outgoing && oldOutIndex >= 0) element.source.businessObject.outgoing.splice(oldOutIndex, 0, bo);
          if (element.target.businessObject.incoming && oldInIndex >= 0) element.target.businessObject.incoming.splice(oldInIndex, 0, bo);
          internals.redrawConnection(element);
        }
      });
      return;
    }

    // shape: also delete connected edges
    const connected = getEdgesConnectedTo(element);
    connected.forEach(deleteElement);

    const bo = element.businessObject;
    const owner = bo.$parent;
    const plane = (defs.diagrams && defs.diagrams[0] && defs.diagrams[0].plane) || null;
    const oldFlowIndex = owner && owner.flowElements ? owner.flowElements.indexOf(bo) : -1;
    const oldDiIndex = plane && plane.planeElement ? plane.planeElement.indexOf(element.di) : -1;
    const oldNodesIndex = graph.nodes.indexOf(element);

    commands.execute({
      name: 'delete-shape',
      do: () => {
        if (oldFlowIndex >= 0) owner.flowElements.splice(owner.flowElements.indexOf(bo), 1);
        if (plane && oldDiIndex >= 0) plane.planeElement.splice(plane.planeElement.indexOf(element.di), 1);
        if (oldNodesIndex >= 0) graph.nodes.splice(graph.nodes.indexOf(element), 1);
        graph.elementsById.delete(element.id);
        internals.removeElementGfx(element.id);
      },
      undo: () => {
        if (oldFlowIndex >= 0) owner.flowElements.splice(oldFlowIndex, 0, bo);
        if (plane && oldDiIndex >= 0) plane.planeElement.splice(oldDiIndex, 0, element.di);
        if (oldNodesIndex >= 0) graph.nodes.splice(oldNodesIndex, 0, element);
        graph.elementsById.set(element.id, element);
        internals.redrawShape(element);
      }
    });
  }

  // Add ////////////////////////////
  function addShape(type, position) {
    const graph = viewer.getGraph();
    const defs = viewer.getDefinitions();
    if (!graph || !defs) return null;

    const owningProcess = findOwningProcess();
    if (!owningProcess) return null;

    const size = DEFAULT_SHAPE_SIZES[type] || { width: 100, height: 80 };
    const x = Math.round(position.x - size.width / 2);
    const y = Math.round(position.y - size.height / 2);

    const id = nextId(type.replace('bpmn:', ''));
    const businessObject = moddle.create(type, { id });
    businessObject.$parent = owningProcess;

    const bounds = moddle.create('dc:Bounds', { x, y, width: size.width, height: size.height });
    const di = moddle.create('bpmndi:BPMNShape', {
      id: id + '_di',
      bpmnElement: businessObject,
      bounds
    });

    const plane = (defs.diagrams && defs.diagrams[0] && defs.diagrams[0].plane) || null;
    const root = findRootContainer();

    const node = {
      id,
      type,
      businessObject,
      di,
      x, y,
      width: size.width,
      height: size.height,
      parent: root,
      children: [],
      hidden: false
    };

    commands.execute({
      name: 'add-shape',
      do: () => {
        owningProcess.flowElements = owningProcess.flowElements || [];
        if (!owningProcess.flowElements.includes(businessObject)) owningProcess.flowElements.push(businessObject);
        if (plane) {
          plane.planeElement = plane.planeElement || [];
          if (!plane.planeElement.includes(di)) plane.planeElement.push(di);
        }
        if (!graph.nodes.includes(node)) graph.nodes.push(node);
        graph.elementsById.set(id, node);
        internals.redrawShape(node);
      },
      undo: () => {
        const fIdx = owningProcess.flowElements.indexOf(businessObject);
        if (fIdx >= 0) owningProcess.flowElements.splice(fIdx, 1);
        if (plane) {
          const dIdx = plane.planeElement.indexOf(di);
          if (dIdx >= 0) plane.planeElement.splice(dIdx, 1);
        }
        const nIdx = graph.nodes.indexOf(node);
        if (nIdx >= 0) graph.nodes.splice(nIdx, 1);
        graph.elementsById.delete(id);
        internals.removeElementGfx(id);
      }
    });

    return node;
  }

  // Label edit /////////////////////
  let labelEditor = null;

  function openLabelEditor(node, evt) {
    if (labelEditor) closeLabelEditor(true);

    const bo = node.businessObject;
    const oldName = bo.name || '';

    const container = viewer.getContainer();
    const containerRect = container.getBoundingClientRect();
    const nodeGfx = internals.elementGfx(node.id);
    const rect = nodeGfx ? nodeGfx.getBoundingClientRect() : null;

    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.spellcheck = false;
    editor.textContent = oldName;
    Object.assign(editor.style, {
      position: 'absolute',
      left: ((rect ? rect.left : containerRect.left + 100) - containerRect.left) + 'px',
      top: ((rect ? rect.top : containerRect.top + 100) - containerRect.top) + 'px',
      width: (rect ? rect.width : 100) + 'px',
      minHeight: (rect ? rect.height : 30) + 'px',
      background: 'white',
      border: '1px solid #1a73e8',
      borderRadius: '2px',
      padding: '2px 4px',
      font: '12px Arial, sans-serif',
      zIndex: 10,
      outline: 'none',
      textAlign: 'center',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    });
    container.appendChild(editor);

    // select all
    const range = document.createRange();
    range.selectNodeContents(editor);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    editor.focus();

    function commit() {
      const newName = editor.textContent;
      cleanup();
      if (newName === oldName) return;
      commands.execute({
        name: 'rename',
        do: () => { bo.name = newName; internals.redrawShape(node); },
        undo: () => { bo.name = oldName; internals.redrawShape(node); }
      });
    }

    function cleanup() {
      if (labelEditor && labelEditor.parentNode) labelEditor.parentNode.removeChild(labelEditor);
      labelEditor = null;
    }

    editor.addEventListener('blur', commit);
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); editor.blur(); }
      else if (e.key === 'Escape') { cleanup(); }
    });

    labelEditor = editor;
    if (evt) evt.preventDefault();
  }

  function closeLabelEditor(commit) {
    if (!labelEditor) return;
    if (commit) labelEditor.blur();
    else if (labelEditor.parentNode) labelEditor.parentNode.removeChild(labelEditor);
    labelEditor = null;
  }

  // Palette ////////////////////////
  let palette = null;

  function buildPalette() {
    if (!opts.palette) return;
    const container = viewer.getContainer();

    palette = document.createElement('div');
    palette.className = 'bpmn-xyflow-palette';
    Object.assign(palette.style, {
      position: 'absolute',
      top: '10px',
      left: '10px',
      background: 'rgba(255, 255, 255, 0.95)',
      border: '1px solid rgba(0, 0, 0, 0.1)',
      borderRadius: '4px',
      padding: '6px',
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      zIndex: 5,
      fontSize: '12px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    });

    const items = [
      { type: 'bpmn:StartEvent', label: 'Start' },
      { type: 'bpmn:Task', label: 'Task' },
      { type: 'bpmn:UserTask', label: 'User Task' },
      { type: 'bpmn:ServiceTask', label: 'Service Task' },
      { type: 'bpmn:ExclusiveGateway', label: 'Gateway' },
      { type: 'bpmn:EndEvent', label: 'End' }
    ];
    items.forEach(item => {
      const btn = document.createElement('button');
      btn.textContent = '+ ' + item.label;
      btn.title = 'Click to add at viewport centre, or drag onto the canvas';
      Object.assign(btn.style, {
        padding: '4px 8px',
        textAlign: 'left',
        cursor: 'grab',
        border: '1px solid #ddd',
        borderRadius: '3px',
        background: 'white',
        font: 'inherit'
      });

      btn.addEventListener('click', () => {
        const v = viewer.getViewport();
        const rect = viewer.getContainer().getBoundingClientRect();
        const center = {
          x: (rect.width / 2 - v.x) / v.zoom,
          y: (rect.height / 2 - v.y) / v.zoom
        };
        center.x += (Math.random() - 0.5) * 80;
        center.y += (Math.random() - 0.5) * 60;
        const node = addShape(item.type, center);
        if (node) viewer.select(node.id);
      });

      // drag-to-canvas: a transparent ghost follows the pointer; on
      // mouseup over the canvas, we addShape at the drop point. The
      // ghost is rendered in the container (HTML) so it can sit above
      // the SVG without fighting the panZoom drag.
      btn.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        let dragged = false;
        const ghost = document.createElement('div');
        ghost.textContent = item.label;
        Object.assign(ghost.style, {
          position: 'fixed',
          left: e.clientX + 'px',
          top: e.clientY + 'px',
          padding: '4px 8px',
          background: 'rgba(255, 255, 255, 0.95)',
          border: '1px dashed #1a73e8',
          borderRadius: '3px',
          font: '12px -apple-system, BlinkMacSystemFont, sans-serif',
          color: '#1a73e8',
          pointerEvents: 'none',
          zIndex: 100
        });
        document.body.appendChild(ghost);

        function move(ev) {
          dragged = true;
          ghost.style.left = ev.clientX + 'px';
          ghost.style.top = ev.clientY + 'px';
        }
        function up(ev) {
          window.removeEventListener('mousemove', move, true);
          window.removeEventListener('mouseup', up, true);
          ghost.remove();
          if (!dragged) return; // plain click handler covers no-drag case
          // only drop if release is over the viewer
          const containerRect = viewer.getContainer().getBoundingClientRect();
          if (ev.clientX < containerRect.left || ev.clientX > containerRect.right ||
              ev.clientY < containerRect.top || ev.clientY > containerRect.bottom) return;
          const p = internals.toGraph(ev.clientX, ev.clientY);
          const node = addShape(item.type, p);
          if (node) viewer.select(node.id);
        }
        window.addEventListener('mousemove', move, true);
        window.addEventListener('mouseup', up, true);
      });

      palette.appendChild(btn);
    });

    container.appendChild(palette);
  }

  // Wiring /////////////////////////
  let attached = false;
  function attachModeling() {
    if (attached) return;
    attached = true;

    const svg = viewer.getSvg();

    // capture-phase mousedown wins the gesture from d3-zoom (XYPanZoom)
    svg.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);

    svg.addEventListener('dblclick', onDblClick);
    svg.addEventListener('keydown', onKeyDown);
    svg.addEventListener('contextmenu', onContextMenu);
  }

  function detachModeling() {
    if (!attached) return;
    attached = false;
    const svg = viewer.getSvg();
    svg.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('mousemove', onMouseMove, true);
    window.removeEventListener('mouseup', onMouseUp, true);
    svg.removeEventListener('dblclick', onDblClick);
    svg.removeEventListener('keydown', onKeyDown);
    svg.removeEventListener('contextmenu', onContextMenu);
  }

  function onDblClick(evt) {
    // double-click on a bendpoint handle → delete that waypoint
    if (evt.target && evt.target.classList && evt.target.classList.contains('bpmn-xyflow-bendpoint')) {
      const idx = Number(evt.target.getAttribute('data-bend-index'));
      if (bendpointEdge && Number.isFinite(idx)) {
        deleteBendpoint(bendpointEdge, idx);
        evt.stopPropagation();
        evt.preventDefault();
      }
      return;
    }

    const id = internals.findElementId(evt.target);
    const node = id ? viewer.getElement(id) : null;
    if (!node || node.waypoints) return;
    openLabelEditor(node, evt);
  }

  function deleteBendpoint(edge, wpIndex) {
    // can't delete source/target endpoints — those are docked to shapes
    if (wpIndex <= 0 || wpIndex >= edge.waypoints.length - 1) return;
    // a connection must have at least 2 waypoints
    if (edge.waypoints.length <= 2) return;

    const original = edge.waypoints.slice();
    const next = edge.waypoints.slice(0, wpIndex).concat(edge.waypoints.slice(wpIndex + 1));

    commands.execute({
      name: 'delete-bendpoint',
      do: () => {
        edge.waypoints = next.slice();
        syncEdgeDi(edge);
        internals.redrawConnection(edge);
        refreshBendpoints();
      },
      undo: () => {
        edge.waypoints = original.slice();
        syncEdgeDi(edge);
        internals.redrawConnection(edge);
        refreshBendpoints();
      }
    });
  }

  function onKeyDown(evt) {
    if (!opts.keyboard) return;

    // Don't capture keys when typing in the label editor
    if (labelEditor && labelEditor.contains(evt.target)) return;

    const isCtrl = evt.ctrlKey || evt.metaKey;
    if (isCtrl && evt.key.toLowerCase() === 'z') {
      if (evt.shiftKey) commands.redo();
      else commands.undo();
      evt.preventDefault();
      return;
    }
    if (isCtrl && evt.key.toLowerCase() === 'y') {
      commands.redo();
      evt.preventDefault();
      return;
    }
    if (isCtrl && evt.key.toLowerCase() === 'c') {
      copySelection();
      evt.preventDefault();
      return;
    }
    if (isCtrl && evt.key.toLowerCase() === 'v') {
      const rect = viewer.getContainer().getBoundingClientRect();
      pasteAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      evt.preventDefault();
      return;
    }
    if (isCtrl && evt.key.toLowerCase() === 'd') {
      // duplicate in place
      copySelection();
      const rect = viewer.getContainer().getBoundingClientRect();
      pasteAtPoint(rect.left + rect.width / 2 + 30, rect.top + rect.height / 2 + 30);
      evt.preventDefault();
      return;
    }
    if (evt.key === 'Delete' || evt.key === 'Backspace') {
      const ids = viewer.getSelection();
      if (!ids.length) return;
      ids.map(id => viewer.getElement(id)).filter(Boolean).forEach(deleteElement);
      viewer.clearSelection();
      evt.preventDefault();
      return;
    }
    // arrow keys: move selected shape by 10px (with shift: 1px)
    if (/^Arrow/.test(evt.key)) {
      const ids = viewer.getSelection();
      const nodes = ids.map(id => viewer.getElement(id)).filter(Boolean).filter(e => !e.waypoints);
      if (!nodes.length) return;
      const step = evt.shiftKey ? 1 : 10;
      const dx = evt.key === 'ArrowLeft' ? -step : evt.key === 'ArrowRight' ? step : 0;
      const dy = evt.key === 'ArrowUp' ? -step : evt.key === 'ArrowDown' ? step : 0;
      // group as a single command
      const moves = nodes.map(n => ({ node: n, from: { x: n.x, y: n.y }, to: { x: n.x + dx, y: n.y + dy } }));
      commands.execute({
        name: 'arrow-move',
        do: () => moves.forEach(m => setNodePosition(m.node, m.to.x, m.to.y)),
        undo: () => moves.forEach(m => setNodePosition(m.node, m.from.x, m.from.y))
      });
      evt.preventDefault();
      return;
    }
    // Tab cycles selection through shapes
    if (evt.key === 'Tab') {
      const graph = viewer.getGraph();
      if (!graph) return;
      const shapes = graph.nodes.filter(n => !n.waypoints && n.type !== 'label' && !n.hidden && n.type && n.type !== 'bpmn:Process');
      if (!shapes.length) return;
      const cur = viewer.getSelection()[0];
      const idx = shapes.findIndex(n => n.id === cur);
      const next = shapes[(idx + (evt.shiftKey ? -1 : 1) + shapes.length) % shapes.length];
      viewer.select(next.id);
      evt.preventDefault();
    }
  }

  // build palette once mounted (container already exists at this point)
  buildPalette();

  // Copy / Paste ///////////////////
  let clipboard = null;

  function copySelection() {
    const ids = viewer.getSelection();
    const elements = ids.map(id => viewer.getElement(id)).filter(Boolean).filter(e => !e.waypoints);
    if (!elements.length) { clipboard = null; return; }
    clipboard = elements.map(el => ({
      type: el.type,
      width: el.width,
      height: el.height,
      x: el.x, y: el.y,
      name: el.businessObject.name
    }));
  }

  function pasteAtPoint(clientX, clientY) {
    if (!clipboard || !clipboard.length) return;
    const p = internals.toGraph(clientX, clientY);
    // place clipboard's centroid at the paste point
    const cx = clipboard.reduce((s, c) => s + c.x + c.width / 2, 0) / clipboard.length;
    const cy = clipboard.reduce((s, c) => s + c.y + c.height / 2, 0) / clipboard.length;
    const dx = p.x - cx, dy = p.y - cy;
    const newIds = [];
    clipboard.forEach(c => {
      const node = addShape(c.type, { x: c.x + c.width / 2 + dx, y: c.y + c.height / 2 + dy });
      if (node && c.name) {
        node.businessObject.name = c.name;
        internals.redrawShape(node);
      }
      if (node) newIds.push(node.id);
    });
    if (newIds.length) viewer.select(newIds);
  }

  // Replace ////////////////////////
  // Morph an element to another BPMN type while preserving its id,
  // bounds, name, position, and connection topology. New properties
  // specific to the target type (e.g. eventDefinitions) are not
  // synthesised here; consumers can pass them in attrs.
  function replaceShape(element, newType, attrs = {}) {
    const graph = viewer.getGraph();
    const defs = viewer.getDefinitions();
    if (!graph || !defs) return null;
    if (!element || element.waypoints) return null;
    if (element.type === newType) return element;

    const oldBo = element.businessObject;
    const owner = oldBo.$parent;
    const plane = (defs.diagrams && defs.diagrams[0] && defs.diagrams[0].plane) || null;
    const oldType = element.type;
    const oldDi = element.di;

    // create the new business object, copy commonly preserved fields
    const newBo = moddle.create(newType, Object.assign({
      id: oldBo.id,
      name: oldBo.name
    }, attrs));
    newBo.$parent = owner;

    // create the new DI shape, preserve bounds
    const bounds = oldDi && oldDi.bounds;
    const newDi = moddle.create('bpmndi:BPMNShape', {
      id: oldDi ? oldDi.id : (newBo.id + '_di'),
      bpmnElement: newBo,
      bounds: bounds && moddle.create('dc:Bounds', { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
    });

    // capture indices for clean undo
    const flowIdx = owner && owner.flowElements ? owner.flowElements.indexOf(oldBo) : -1;
    const diIdx = plane && plane.planeElement ? plane.planeElement.indexOf(oldDi) : -1;

    // edges currently referencing oldBo (need to be re-pointed on do)
    const incoming = graph.edges.filter(e => e.target === element);
    const outgoing = graph.edges.filter(e => e.source === element);

    commands.execute({
      name: 'replace-shape',
      do: () => {
        if (flowIdx >= 0) owner.flowElements[flowIdx] = newBo;
        if (plane && diIdx >= 0) plane.planeElement[diIdx] = newDi;
        element.type = newType;
        element.businessObject = newBo;
        element.di = newDi;
        // re-point edge sourceRef/targetRef on the moddle side
        outgoing.forEach(e => { e.businessObject.sourceRef = newBo; });
        incoming.forEach(e => { e.businessObject.targetRef = newBo; });
        // re-crop now that the shape geometry may have changed
        const bpmnRenderer = internals.renderer && internals.renderer.bpmnRenderer;
        if (bpmnRenderer) {
          [ ...incoming, ...outgoing ].forEach(e => {
            e.waypoints = cropWaypoints(e.waypoints, e.source, e.target, bpmnRenderer);
            syncEdgeDi(e);
          });
        }
        internals.redrawShape(element);
        [ ...incoming, ...outgoing ].forEach(e => internals.redrawConnection(e));
        if (bendpointEdge && (incoming.includes(bendpointEdge) || outgoing.includes(bendpointEdge))) refreshBendpoints();
      },
      undo: () => {
        if (flowIdx >= 0) owner.flowElements[flowIdx] = oldBo;
        if (plane && diIdx >= 0) plane.planeElement[diIdx] = oldDi;
        element.type = oldType;
        element.businessObject = oldBo;
        element.di = oldDi;
        outgoing.forEach(e => { e.businessObject.sourceRef = oldBo; });
        incoming.forEach(e => { e.businessObject.targetRef = oldBo; });
        const bpmnRenderer = internals.renderer && internals.renderer.bpmnRenderer;
        if (bpmnRenderer) {
          [ ...incoming, ...outgoing ].forEach(e => {
            e.waypoints = cropWaypoints(e.waypoints, e.source, e.target, bpmnRenderer);
            syncEdgeDi(e);
          });
        }
        internals.redrawShape(element);
        [ ...incoming, ...outgoing ].forEach(e => internals.redrawConnection(e));
      }
    });

    return element;
  }

  // Public modeling API ////////////
  this.addShape = addShape;
  this.connect = createSequenceFlow;
  this.delete = deleteElement;
  this.replace = replaceShape;
  this.undo = () => commands.undo();
  this.redo = () => commands.redo();
  this.canUndo = () => commands.canUndo();
  this.canRedo = () => commands.canRedo();

  this.getXML = async function(options = {}) {
    const defs = viewer.getDefinitions();
    if (!defs) throw new Error('no diagram loaded');
    const { xml } = await moddle.toXML(defs, { format: options.format !== false });
    return xml;
  };
}
