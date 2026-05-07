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
import { getConnectionType, canReconnect, canAttachBoundary, canBeParent } from './modeling/Rules';

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
const EXTERNAL_LABEL_TYPES = [
  'bpmn:StartEvent', 'bpmn:EndEvent',
  'bpmn:IntermediateThrowEvent', 'bpmn:IntermediateCatchEvent',
  'bpmn:BoundaryEvent',
  'bpmn:ExclusiveGateway', 'bpmn:ParallelGateway',
  'bpmn:InclusiveGateway', 'bpmn:EventBasedGateway', 'bpmn:ComplexGateway',
  'bpmn:DataObjectReference', 'bpmn:DataStoreReference',
  'bpmn:DataInput', 'bpmn:DataOutput'
];

function hasExternalLabel(type) {
  return EXTERNAL_LABEL_TYPES.indexOf(type) !== -1;
}

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

  // Refresh the minimap whenever the diagram changes (any command).
  commands.onChange(() => {
    if (internals && typeof internals.refreshMinimap === 'function') {
      internals.refreshMinimap();
    }
  });
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
      ensureGridBackground();
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

  /**
   * Drop any intermediate waypoint that sits on the line between its
   * immediate neighbours (cross-product = 0 within tolerance). Called
   * after bend / segment edits so the path stays minimal.
   */
  function dropCollinear(waypoints) {
    if (waypoints.length <= 2) return waypoints;
    const out = [ waypoints[0] ];
    for (let i = 1; i < waypoints.length - 1; i++) {
      const a = out[out.length - 1];
      const b = waypoints[i];
      const c = waypoints[i + 1];
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (Math.abs(cross) > 1) out.push(b);
    }
    out.push(waypoints[waypoints.length - 1]);
    return out;
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
    destroyConnectHandle();
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
    destroyConnectHandle();
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
    edge.waypoints = dropCollinear(edge.waypoints);
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

  function endBendDrag(evt) {
    if (!bendDragState) return;
    const { edge, wpIndex, originalWaypoints, moved, inserted } = bendDragState;
    bendDragState = null;
    if (!moved && !inserted) return;

    // Reconnect: if the dragged waypoint is the source (idx 0) or
    // target (idx last) endpoint AND we released the pointer over a
    // different shape than the current end, retarget the connection.
    const isSourceEnd = wpIndex === 0;
    const isTargetEnd = wpIndex === originalWaypoints.length - 1;
    let reconnect = null;
    if ((isSourceEnd || isTargetEnd) && evt) {
      const dropped = elementAtPoint(evt.clientX, evt.clientY, { shapesOnly: true, skip: edge });
      if (dropped && !dropped.waypoints && dropped !== (isSourceEnd ? edge.source : edge.target)) {
        const side = isSourceEnd ? 'source' : 'target';
        const newType = canReconnect(edge, side, dropped);
        if (newType) {
          reconnect = { side, newEnd: dropped, newType };
        }
      }
    }

    edge.waypoints = dropCollinear(edge.waypoints);
    syncEdgeDi(edge);
    internals.redrawConnection(edge);
    refreshBendpoints();
    const finalWaypoints = edge.waypoints.slice();
    const oldSource = edge.source;
    const oldTarget = edge.target;
    const oldType = edge.type;
    const oldBoSourceRef = edge.businessObject.sourceRef;
    const oldBoTargetRef = edge.businessObject.targetRef;

    if (reconnect) {
      // Snap the dragged endpoint to the new shape's boundary
      const newEnd = reconnect.newEnd;
      const otherEnd = reconnect.side === 'source' ? oldTarget : oldSource;
      const provisional = finalWaypoints.slice();
      provisional[reconnect.side === 'source' ? 0 : provisional.length - 1] = getMid(newEnd);
      const bpmnRenderer = internals.renderer && internals.renderer.bpmnRenderer;
      const cropped = bpmnRenderer
        ? cropWaypoints(provisional,
            reconnect.side === 'source' ? newEnd : oldSource,
            reconnect.side === 'source' ? oldTarget : newEnd,
            bpmnRenderer)
        : provisional;
      finalWaypoints.splice(0, finalWaypoints.length, ...cropped);
    }

    commands.execute({
      name: reconnect ? 'reconnect' : (inserted ? 'insert-bendpoint' : 'move-bendpoint'),
      do: () => {
        edge.waypoints = finalWaypoints.slice();
        if (reconnect) {
          if (reconnect.side === 'source') {
            // remove from old source's outgoing; add to new source's outgoing
            const oldOutgoing = oldSource.businessObject.outgoing;
            if (Array.isArray(oldOutgoing)) {
              const i = oldOutgoing.indexOf(edge.businessObject);
              if (i >= 0) oldOutgoing.splice(i, 1);
            }
            edge.source = reconnect.newEnd;
            edge.businessObject.sourceRef = reconnect.newEnd.businessObject;
            const newOutgoing = reconnect.newEnd.businessObject.outgoing = reconnect.newEnd.businessObject.outgoing || [];
            if (!newOutgoing.includes(edge.businessObject)) newOutgoing.push(edge.businessObject);
          } else {
            const oldIncoming = oldTarget.businessObject.incoming;
            if (Array.isArray(oldIncoming)) {
              const i = oldIncoming.indexOf(edge.businessObject);
              if (i >= 0) oldIncoming.splice(i, 1);
            }
            edge.target = reconnect.newEnd;
            edge.businessObject.targetRef = reconnect.newEnd.businessObject;
            const newIncoming = reconnect.newEnd.businessObject.incoming = reconnect.newEnd.businessObject.incoming || [];
            if (!newIncoming.includes(edge.businessObject)) newIncoming.push(edge.businessObject);
          }
          if (reconnect.newType !== oldType) {
            edge.type = reconnect.newType;
          }
        }
        syncEdgeDi(edge);
        internals.redrawConnection(edge);
        refreshBendpoints();
      },
      undo: () => {
        edge.waypoints = originalWaypoints.slice();
        if (reconnect) {
          // restore old endpoint's array, drop from new endpoint's
          if (reconnect.side === 'source') {
            const newOutgoing = reconnect.newEnd.businessObject.outgoing;
            if (Array.isArray(newOutgoing)) {
              const i = newOutgoing.indexOf(edge.businessObject);
              if (i >= 0) newOutgoing.splice(i, 1);
            }
            const oldOutgoing = oldSource.businessObject.outgoing = oldSource.businessObject.outgoing || [];
            if (!oldOutgoing.includes(edge.businessObject)) oldOutgoing.push(edge.businessObject);
          } else {
            const newIncoming = reconnect.newEnd.businessObject.incoming;
            if (Array.isArray(newIncoming)) {
              const i = newIncoming.indexOf(edge.businessObject);
              if (i >= 0) newIncoming.splice(i, 1);
            }
            const oldIncoming = oldTarget.businessObject.incoming = oldTarget.businessObject.incoming || [];
            if (!oldIncoming.includes(edge.businessObject)) oldIncoming.push(edge.businessObject);
          }
          edge.source = oldSource;
          edge.target = oldTarget;
          edge.businessObject.sourceRef = oldBoSourceRef;
          edge.businessObject.targetRef = oldBoTargetRef;
          edge.type = oldType;
        }
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
        const hovered = elementAtPoint(ev.clientX, ev.clientY, { shapesOnly: true, skip: element });
        updateConnectPreview(q.x, q.y, hovered);
      }
      function up(ev) {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
        const target = elementAtPoint(ev.clientX, ev.clientY, { shapesOnly: true });
        endConnect(target && !target.waypoints ? target : null);
      }
      window.addEventListener('mousemove', move, true);
      window.addEventListener('mouseup', up, true);
    }));

    contextPad.appendChild(makePadButton('▭', 'Append Task', () => {
      let newNode;
      commands.compound('append-task', () => {
        newNode = addShape('bpmn:Task', { x: element.x + element.width + 80, y: element.y + element.height / 2 });
        if (newNode) createSequenceFlow(element, newNode);
      });
      if (newNode) viewer.select(newNode.id);
    }));

    contextPad.appendChild(makePadButton('⇆', 'Change type — opens a quick replace menu', (e) => {
      openReplaceMenu(element, e.clientX, e.clientY);
    }));

    container.appendChild(contextPad);

    // Flip / clamp so the pad stays inside the container.
    const padRect = contextPad.getBoundingClientRect();
    let leftPx = parseFloat(contextPad.style.left);
    let topPx = parseFloat(contextPad.style.top);
    const overflowRight = (leftPx + padRect.width) - containerRect.width;
    if (overflowRight > 0) {
      // place to the left of the shape instead
      leftPx = (elRect.left - containerRect.left) - padRect.width - 6;
      if (leftPx < 4) leftPx = 4;
      contextPad.style.left = leftPx + 'px';
    }
    const overflowBottom = (topPx + padRect.height) - containerRect.height;
    if (overflowBottom > 0) {
      topPx = Math.max(4, topPx - overflowBottom - 4);
      contextPad.style.top = topPx + 'px';
    }
    if (topPx < 0) contextPad.style.top = '4px';
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
      // family swap (none + 8 event definitions × 4 roles ≈ 36 items;
      // we keep this menu focused on the most common combinations)
      const families = [
        [ 'bpmn:StartEvent', 'Start' ],
        [ 'bpmn:IntermediateCatchEvent', 'Catch' ],
        [ 'bpmn:IntermediateThrowEvent', 'Throw' ],
        [ 'bpmn:EndEvent', 'End' ]
      ].filter(([ t ]) => t !== type);
      const definitions = [
        [ null, 'None' ],
        [ 'bpmn:MessageEventDefinition', 'Message' ],
        [ 'bpmn:TimerEventDefinition', 'Timer' ],
        [ 'bpmn:SignalEventDefinition', 'Signal' ],
        [ 'bpmn:ErrorEventDefinition', 'Error' ],
        [ 'bpmn:EscalationEventDefinition', 'Escalation' ],
        [ 'bpmn:ConditionalEventDefinition', 'Conditional' ],
        [ 'bpmn:CompensateEventDefinition', 'Compensate' ],
        [ 'bpmn:TerminateEventDefinition', 'Terminate' ]
      ];
      const out = families.map(([ t, label ]) => [ t, label, null ]);
      // also let the user change the event definition while keeping
      // the same family (current type stays)
      definitions.forEach(([ defType, defLabel ]) => {
        out.push([ type, `${ shortLabel(type) } · ${ defLabel }`, defType ]);
      });
      return out;
    }
    return [];
  }

  function shortLabel(type) {
    return type.replace('bpmn:', '').replace('Event', '');
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

    items.forEach(([ type, label, eventDefinition ]) => {
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
        const attrs = {};
        if (eventDefinition !== undefined) {
          // null = remove all event definitions; non-null = single def
          attrs.__eventDefinition = eventDefinition;
        }
        replaceShape(element, type, attrs);
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
    destroyConnectHandle();
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

  // Selection marker overlay ///////
  // A dashed-outline rectangle drawn around every selected shape.
  // Mirrors bpmn-js's "djs-outline" visual; sits in its own group
  // above the connection layer so it isn't hidden by edges.

  let selectionMarkers = null;

  function ensureSelectionMarkers() {
    if (selectionMarkers) return selectionMarkers;
    selectionMarkers = svgCreate('g', { 'class': 'bpmn-xyflow-selection-markers' });
    svgAppend(internals.viewport, selectionMarkers);
    return selectionMarkers;
  }

  function refreshSelectionMarkers() {
    const g = ensureSelectionMarkers();
    while (g.firstChild) g.removeChild(g.firstChild);
    const ids = viewer.getSelection();
    ids.forEach(id => {
      const el = viewer.getElement(id);
      if (!el || el.type === 'label' || el.hidden) return;

      // Edge: bbox around its waypoints
      if (el.waypoints && el.waypoints.length) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        el.waypoints.forEach(p => {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        });
        const PAD = 4;
        const rect = svgCreate('rect', {
          x: minX - PAD, y: minY - PAD,
          width: (maxX - minX) + 2 * PAD,
          height: (maxY - minY) + 2 * PAD,
          rx: 4, ry: 4,
          fill: 'none',
          stroke: '#1a73e8',
          'stroke-width': 1,
          'stroke-dasharray': '4,3',
          'pointer-events': 'none'
        });
        svgAppend(g, rect);
        return;
      }

      // Shape: bbox around the shape body
      const PAD = 6;
      const rect = svgCreate('rect', {
        x: el.x - PAD, y: el.y - PAD,
        width: el.width + 2 * PAD,
        height: el.height + 2 * PAD,
        rx: 6, ry: 6,
        fill: 'none',
        stroke: '#1a73e8',
        'stroke-width': 1,
        'stroke-dasharray': '4,3',
        'pointer-events': 'none'
      });
      svgAppend(g, rect);
    });
  }

  viewer.on('selection.change', () => refreshSelectionMarkers());

  // Connection label drag //////////
  let labelDragState = null;

  function closestWithAttr(node, attr) {
    let n = node;
    while (n && n !== document) {
      if (n.getAttribute && n.getAttribute(attr)) return n;
      n = n.parentNode;
    }
    return null;
  }

  function startConnectionLabelDrag(edge, host, evt) {
    destroyConnectHandle();
    const transform = host.getAttribute('transform') || '';
    const m = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(transform);
    const startPos = m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
    const p = internals.toGraph(evt.clientX, evt.clientY);
    labelDragState = {
      edge, host,
      origin: startPos,
      offset: { x: p.x - startPos.x, y: p.y - startPos.y },
      moved: false
    };
  }

  function updateConnectionLabelDrag(evt) {
    if (!labelDragState) return;
    const p = internals.toGraph(evt.clientX, evt.clientY);
    const newX = Math.round(p.x - labelDragState.offset.x);
    const newY = Math.round(p.y - labelDragState.offset.y);
    labelDragState.host.setAttribute('transform', `translate(${ newX }, ${ newY })`);
    labelDragState.current = { x: newX, y: newY };
    labelDragState.moved = true;
  }

  function endConnectionLabelDrag() {
    if (!labelDragState) return;
    const { edge, origin, current, moved } = labelDragState;
    labelDragState = null;
    if (!moved) return;
    const finalPos = current;
    const beforeLabel = edge.di && edge.di.label;
    const before = beforeLabel && beforeLabel.bounds
      ? { x: beforeLabel.bounds.x, y: beforeLabel.bounds.y, width: beforeLabel.bounds.width, height: beforeLabel.bounds.height }
      : null;
    commands.execute({
      name: 'move-connection-label',
      do: () => {
        const bounds = (edge.di.label && edge.di.label.bounds) || moddle.create('dc:Bounds', { x: 0, y: 0, width: 90, height: 20 });
        bounds.x = finalPos.x;
        bounds.y = finalPos.y;
        bounds.width = before ? before.width : 90;
        bounds.height = before ? before.height : 20;
        if (!edge.di.label) {
          edge.di.label = moddle.create('bpmndi:BPMNLabel', { bounds });
        } else {
          edge.di.label.bounds = bounds;
        }
        internals.redrawConnection(edge);
        if (bendpointEdge === edge) refreshBendpoints();
      },
      undo: () => {
        if (before) {
          edge.di.label.bounds = moddle.create('dc:Bounds', before);
        } else {
          edge.di.label = null;
        }
        internals.redrawConnection(edge);
        if (bendpointEdge === edge) refreshBendpoints();
      }
    });
  }

  // Snap engine /////////////////////
  // Snaps a moving anchor (top-left of the dragged "anchor" shape) to:
  //   1. alignment lines with sibling shapes (their left/centre/right
  //      and top/middle/bottom)
  //   2. a 5px grid (only if no shape-snap caught the cursor)
  // Returns the snapped { x, y } and the guide segments to draw.

  const SNAP_THRESHOLD = 6;   // pixels in graph coords
  const GRID_SIZE = 5;

  function computeSnap(anchor, x, y, draggingNodes) {
    if (opts.snap === false) return { x, y, guides: [] };
    const graph = viewer.getGraph();
    if (!graph) return { x, y, guides: [] };
    const moving = new Set(draggingNodes);
    const others = graph.nodes.filter(n =>
      !moving.has(n) && !n.waypoints && n.type !== 'label' &&
      typeof n.x === 'number' && !n.hidden &&
      // skip lanes/pools — they're containers, not alignment targets
      !(n.businessObject && n.businessObject.$instanceOf &&
        (n.businessObject.$instanceOf('bpmn:Lane') || n.businessObject.$instanceOf('bpmn:Participant')))
    );

    // Candidate alignment values (X) and (Y) from sibling shapes, plus
    // labels for the guide-drawer.
    const xLines = [];
    const yLines = [];
    others.forEach(n => {
      const cx = n.x + n.width / 2;
      const cy = n.y + n.height / 2;
      xLines.push({ value: n.x,                kind: 'left',   span: [n.y, n.y + n.height] });
      xLines.push({ value: cx,                 kind: 'centre', span: [n.y, n.y + n.height] });
      xLines.push({ value: n.x + n.width,      kind: 'right',  span: [n.y, n.y + n.height] });
      yLines.push({ value: n.y,                kind: 'top',    span: [n.x, n.x + n.width] });
      yLines.push({ value: cy,                 kind: 'middle', span: [n.x, n.x + n.width] });
      yLines.push({ value: n.y + n.height,     kind: 'bottom', span: [n.x, n.x + n.width] });
    });

    const aw = anchor.width;
    const ah = anchor.height;
    // anchor positions to test against each X line: left, centre, right
    const xCandidates = [
      { name: 'left',   offset: 0      },
      { name: 'centre', offset: aw / 2 },
      { name: 'right',  offset: aw     }
    ];
    const yCandidates = [
      { name: 'top',    offset: 0      },
      { name: 'middle', offset: ah / 2 },
      { name: 'bottom', offset: ah     }
    ];

    const guides = [];
    let snappedX = null, snappedY = null;

    for (const cand of xCandidates) {
      for (const line of xLines) {
        if (Math.abs(x + cand.offset - line.value) <= SNAP_THRESHOLD) {
          if (snappedX === null || Math.abs(x + cand.offset - line.value) < Math.abs(snappedX - line.value)) {
            snappedX = line.value - cand.offset;
            const top = Math.min(line.span[0], y);
            const bottom = Math.max(line.span[1], y + ah);
            guides.push({ orient: 'v', x: line.value, y1: top, y2: bottom });
          }
        }
      }
    }
    for (const cand of yCandidates) {
      for (const line of yLines) {
        if (Math.abs(y + cand.offset - line.value) <= SNAP_THRESHOLD) {
          if (snappedY === null || Math.abs(y + cand.offset - line.value) < Math.abs(snappedY - line.value)) {
            snappedY = line.value - cand.offset;
            const left = Math.min(line.span[0], x);
            const right = Math.max(line.span[1], x + aw);
            guides.push({ orient: 'h', y: line.value, x1: left, x2: right });
          }
        }
      }
    }

    // Fallback: grid snap when no shape lined up
    if (snappedX === null) snappedX = Math.round(x / GRID_SIZE) * GRID_SIZE;
    if (snappedY === null) snappedY = Math.round(y / GRID_SIZE) * GRID_SIZE;

    return { x: snappedX, y: snappedY, guides };
  }

  // Alignment-guide overlay ////////
  let guidesGroup = null;
  function drawAlignmentGuides(segments) {
    if (!guidesGroup) {
      guidesGroup = svgCreate('g', { 'class': 'bpmn-xyflow-guides' });
      svgAppend(internals.viewport, guidesGroup);
    }
    while (guidesGroup.firstChild) guidesGroup.removeChild(guidesGroup.firstChild);
    segments.forEach(g => {
      const line = svgCreate('line', g.orient === 'v'
        ? { x1: g.x, x2: g.x, y1: g.y1, y2: g.y2 }
        : { x1: g.x1, x2: g.x2, y1: g.y, y2: g.y });
      svgAttr(line, {
        stroke: '#00bcd4', 'stroke-width': 1, 'stroke-dasharray': '4,3', 'pointer-events': 'none'
      });
      svgAppend(guidesGroup, line);
    });
  }
  function clearAlignmentGuides() {
    if (guidesGroup) {
      while (guidesGroup.firstChild) guidesGroup.removeChild(guidesGroup.firstChild);
    }
  }

  // Grid background ////////////////
  function ensureGridBackground() {
    const svg = viewer.getSvg();
    let defs = svg.querySelector(':scope > defs');
    if (!defs) { defs = svgCreate('defs'); svgAppend(svg, defs); }
    if (defs.querySelector('#bpmn-xyflow-grid')) return;

    const pattern = svgCreate('pattern', {
      id: 'bpmn-xyflow-grid', x: 0, y: 0, width: 50, height: 50,
      patternUnits: 'userSpaceOnUse'
    });
    const dot = svgCreate('circle', { cx: 1, cy: 1, r: 0.6, fill: 'rgba(0,0,0,0.18)' });
    svgAppend(pattern, dot);
    svgAppend(defs, pattern);

    const bg = svgCreate('rect', {
      'class': 'bpmn-xyflow-grid-bg',
      x: -1e5, y: -1e5, width: 2e5, height: 2e5,
      fill: 'url(#bpmn-xyflow-grid)',
      'pointer-events': 'none'
    });
    // insert as the first child of viewport so grid sits behind everything
    internals.viewport.insertBefore(bg, internals.viewport.firstChild);
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
    destroyConnectHandle();
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

    // Snap the edge that's actually moving to neighbouring shape
    // alignment lines, falling back to the 5px grid.
    const snapped = snapResize(dir, nx, ny, nw, nh, node);
    nx = snapped.x; ny = snapped.y; nw = snapped.w; nh = snapped.h;

    nx = Math.round(nx); ny = Math.round(ny); nw = Math.round(nw); nh = Math.round(nh);
    if (nx === node.x && ny === node.y && nw === node.width && nh === node.height) return;

    applyResize(node, nx, ny, nw, nh, resizeDragState.anchors);
    resizeDragState.moved = true;
  }

  /**
   * Snap the edge(s) being resized to nearby sibling-shape alignment
   * lines or to the grid. Only the dragged edge moves; the opposite
   * edge stays fixed.
   */
  function snapResize(dir, nx, ny, nw, nh, node) {
    if (opts.snap === false) return { x: nx, y: ny, w: nw, h: nh };
    const graph = viewer.getGraph();
    if (!graph) return { x: nx, y: ny, w: nw, h: nh };

    const others = graph.nodes.filter(n =>
      n !== node && !n.waypoints && n.type !== 'label' &&
      typeof n.x === 'number' && !n.hidden &&
      !(n.businessObject && n.businessObject.$instanceOf &&
        (n.businessObject.$instanceOf('bpmn:Lane') || n.businessObject.$instanceOf('bpmn:Participant')))
    );
    const xCands = [];
    const yCands = [];
    others.forEach(n => {
      xCands.push(n.x, n.x + n.width / 2, n.x + n.width);
      yCands.push(n.y, n.y + n.height / 2, n.y + n.height);
    });

    function snap1D(value, candidates) {
      let best = null, bestDist = SNAP_THRESHOLD + 1;
      candidates.forEach(c => {
        const d = Math.abs(value - c);
        if (d < bestDist) { bestDist = d; best = c; }
      });
      return best !== null
        ? best
        : Math.round(value / GRID_SIZE) * GRID_SIZE;
    }

    if (dir.id.includes('w')) {
      const newLeft = snap1D(nx, xCands);
      const dx = newLeft - nx;
      nx += dx; nw -= dx;
    } else if (dir.id.includes('e')) {
      const newRight = snap1D(nx + nw, xCands);
      nw = newRight - nx;
    }
    if (dir.id.includes('n')) {
      const newTop = snap1D(ny, yCands);
      const dy = newTop - ny;
      ny += dy; nh -= dy;
    } else if (dir.id.includes('s')) {
      const newBottom = snap1D(ny + nh, yCands);
      nh = newBottom - ny;
    }

    const minSize = 20;
    if (nw < minSize) nw = minSize;
    if (nh < minSize) nh = minSize;
    return { x: nx, y: ny, w: nw, h: nh };
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
    refreshSelectionMarkers();
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
        refreshSelectionMarkers();
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
        refreshSelectionMarkers();
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
        const hovered = elementAtPoint(ev.clientX, ev.clientY, { shapesOnly: true, skip: node });
        updateConnectPreview(q.x, q.y, hovered);
      }
      function up(ev) {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
        const target = elementAtPoint(ev.clientX, ev.clientY, { shapesOnly: true });
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

  // Sticky connect handle: instead of racing a setTimeout against the
  // browser's :hover state on a tiny SVG circle, we listen to mousemove
  // ourselves and decide whether the cursor is still inside the
  // shape OR the handle band on the right edge. This makes the handle
  // survive fast cursor moves and small SVG hit-targets at low zoom.
  function isCursorOverConnectArea(clientX, clientY) {
    if (!hoveredForConnect || !connectHandle) return false;
    const node = hoveredForConnect;
    const p = internals.toGraph(clientX, clientY);
    // Generous hit region: shape body + ~24px past the right edge for
    // approaching the handle. Slightly oversized so users don't lose
    // it during normal mouse motion.
    const PAD = 24;
    return (
      p.x >= node.x - 4 &&
      p.x <= node.x + node.width + PAD &&
      p.y >= node.y - 8 &&
      p.y <= node.y + node.height + 8
    );
  }

  viewer.getSvg().addEventListener('mousemove', (evt) => {
    if (!connectHandle || dragState || connectState) return;
    if (!isCursorOverConnectArea(evt.clientX, evt.clientY)) {
      destroyConnectHandle();
    }
  }, true);

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
        let n;
        commands.compound('append-task', () => {
          n = addShape('bpmn:Task', { x: el.x + el.width + 80, y: el.y + el.height / 2 });
          if (n) createSequenceFlow(el, n);
        });
        if (n) viewer.select(n.id);
      } });
      items.push({ label: 'Change type…', action: () => openReplaceMenu(el, evt.clientX, evt.clientY) });

      const isActivity = el.businessObject && el.businessObject.$instanceOf && el.businessObject.$instanceOf('bpmn:Activity');
      if (isActivity) {
        items.push({ label: 'Toggle loop',          action: () => toggleActivityMarker(el, 'loop') });
        items.push({ label: 'Toggle parallel-MI',   action: () => toggleActivityMarker(el, 'parallelMI') });
        items.push({ label: 'Toggle sequential-MI', action: () => toggleActivityMarker(el, 'sequentialMI') });
        items.push({ label: 'Toggle compensation',  action: () => toggleActivityMarker(el, 'compensation') });
      }

      const isSubProcess = el.businessObject && el.businessObject.$instanceOf && el.businessObject.$instanceOf('bpmn:SubProcess');
      if (isSubProcess) {
        items.push({ label: 'Toggle expanded / collapsed', action: () => toggleSubProcessExpanded(el) });
        items.push({ label: 'Drill into sub-process',      action: () => drillInto(el) });
      }

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
  /**
   * Translate the docked endpoint(s) of `edge` by (dx, dy).
   *
   * A shape move is pure translation — the docked endpoint stays at
   * the same point on the (translated) shape boundary, so we do not
   * re-crop. Cropping during translation introduces non-reversible
   * drift over many ticks of a drag and breaks undo round-trips.
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
    syncEdgeDi(edge);
    internals.redrawConnection(edge);
    if (bendpointEdge === edge) refreshBendpoints();
  }

  /**
   * Move a node without touching connected edges.
   * Used by undoable commands that manage waypoints themselves.
   *
   * Also translates di.label.bounds when the node has an external
   * label so the label DI follows the host across export/import.
   */
  /**
   * Move every BoundaryEvent attached to `node` by the same delta —
   * boundaries are pinned to their host activity in BPMN semantics,
   * so dragging the host should drag them too.
   */
  function translateAttachersOf(node, dx, dy) {
    const attachers = node && node.attachers;
    if (!Array.isArray(attachers) || !attachers.length) return;
    attachers.forEach(att => {
      // Re-enter setNodePosition so the boundary's own connected
      // edges, label, etc. all shift with it. Guard against cycles.
      if (att && typeof att.x === 'number') {
        setNodePositionInternal(att, att.x + dx, att.y + dy);
      }
    });
  }

  /**
   * Internal recursion-guard version of setNodePosition for cascading
   * follower moves (attachers). Avoids re-translating the host's own
   * attachers (the recursion goes one level for boundaries).
   */
  function setNodePositionInternal(node, x, y) {
    const dx = x - node.x;
    const dy = y - node.y;
    if (dx === 0 && dy === 0) return;
    node.x = x; node.y = y;
    if (node.di && node.di.bounds) {
      node.di.bounds.x = x;
      node.di.bounds.y = y;
    }
    if (node.di && node.di.label && node.di.label.bounds) {
      node.di.label.bounds.x += dx;
      node.di.label.bounds.y += dy;
    }
    const gfx = internals.elementGfx(node.id);
    if (gfx) gfx.setAttribute('transform', `translate(${ x }, ${ y })`);
    translateLabelOf(node, dx, dy);
    getEdgesConnectedTo(node).forEach(edge => shiftEdgeEndpoints(edge, node, dx, dy));
  }

  /**
   * Move the host node's separate external-label graph node (added by
   * the Importer for events / gateways / data objects) and its gfx by
   * (dx, dy) so it stays attached to the host across drags and undo.
   */
  function translateLabelOf(node, dx, dy) {
    const label = node && node.label;
    if (!label) return;
    label.x += dx;
    label.y += dy;
    if (label.di && label.di.bounds) {
      label.di.bounds.x += dx;
      label.di.bounds.y += dy;
    }
    const lgfx = internals.elementGfx(label.id);
    if (lgfx) lgfx.setAttribute('transform', `translate(${ label.x }, ${ label.y })`);
  }

  function setNodePositionRaw(node, x, y) {
    if (node.x === x && node.y === y) return;
    const dx = x - node.x;
    const dy = y - node.y;
    node.x = x;
    node.y = y;
    if (node.di && node.di.bounds) {
      node.di.bounds.x = x;
      node.di.bounds.y = y;
    }
    if (node.di && node.di.label && node.di.label.bounds) {
      node.di.label.bounds.x += dx;
      node.di.label.bounds.y += dy;
    }
    const gfx = internals.elementGfx(node.id);
    if (gfx) gfx.setAttribute('transform', `translate(${ x }, ${ y })`);
    // The Importer-created label is a SEPARATE graph node with its
    // own gfx in the label layer. Move it (and its gfx) by the same
    // delta so it stays attached to the host across drag/undo/redo.
    translateLabelOf(node, dx, dy);
    translateAttachersOf(node, dx, dy);
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
    if (node.di && node.di.label && node.di.label.bounds) {
      node.di.label.bounds.x += dx;
      node.di.label.bounds.y += dy;
    }

    // re-position the existing gfx without re-rendering
    const gfx = internals.elementGfx(node.id);
    if (gfx) gfx.setAttribute('transform', `translate(${ x }, ${ y })`);

    // separate external-label node (for events / gateways / data
    // objects) follows by the same delta
    translateLabelOf(node, dx, dy);
    translateAttachersOf(node, dx, dy);

    // shift connected-edge endpoints by the same delta — preserve bends
    getEdgesConnectedTo(node).forEach(edge => shiftEdgeEndpoints(edge, node, dx, dy));

    internals.refreshSelection();
    repositionContextPad();
    refreshResizeHandles();
    refreshSelectionMarkers();
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

  /**
   * Returns the flowElements-owning bo for the *currently rendered*
   * diagram. When the user has drilled into a SubProcess, this is
   * that SubProcess; otherwise it walks back to a Process (or the
   * Collaboration's first participant's processRef). Falls back to
   * findOwningProcess() if no rendered root is suitable.
   */
  function findCurrentContainer() {
    const root = findRootContainer();
    const bo = root && root.businessObject;
    if (bo && bo.$instanceOf) {
      if (bo.$instanceOf('bpmn:SubProcess') || bo.$instanceOf('bpmn:Process')) return bo;
      if (bo.$instanceOf('bpmn:Participant') && bo.processRef) return bo.processRef;
      if (bo.$instanceOf('bpmn:Collaboration')) {
        const p = (bo.participants || []).find(x => x.processRef);
        if (p) return p.processRef;
      }
    }
    return findOwningProcess();
  }

  /**
   * Returns the BPMNPlane that's currently rendered. After drillInto,
   * this is the SubProcess's plane, not the root diagram's plane.
   */
  function findCurrentPlane() {
    const defs = viewer.getDefinitions();
    if (!defs || !Array.isArray(defs.diagrams)) return null;
    const rootBo = findRootContainer() && findRootContainer().businessObject;
    if (rootBo) {
      const d = defs.diagrams.find(diag => diag.plane && diag.plane.bpmnElement === rootBo);
      if (d) return d.plane;
    }
    return defs.diagrams[0] && defs.diagrams[0].plane;
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

    // 0a. handle mousedown on a connection label → drag the label
    //     (test the target and its ancestors for the data attribute)
    const labelHost = closestWithAttr(evt.target, 'data-connection-label');
    if (labelHost) {
      const id = labelHost.getAttribute('data-element-id');
      const edge = id ? viewer.getElement(id) : null;
      if (edge && edge.waypoints) {
        startConnectionLabelDrag(edge, labelHost, evt);
        evt.stopPropagation();
        evt.preventDefault();
        return;
      }
    }

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
    const rawNodes = selected.includes(el.id)
      ? selected.map(i => viewer.getElement(i)).filter(n => n && !n.waypoints && 'x' in n)
      : [ el ];

    // Dedupe: if any selected node is a BoundaryEvent whose host is
    // ALSO selected, exclude the boundary — translateAttachersOf will
    // move it via the host so we don't apply (dx, dy) twice.
    const nodeSet = new Set(rawNodes);
    const draggedNodes = rawNodes.filter(n => !(n.host && nodeSet.has(n.host)));

    // Snapshot the waypoint state of every connected edge BEFORE the
    // drag begins — undo restores from this snapshot rather than from
    // the post-drag waypoints.
    const edgeSet = new Set();
    rawNodes.forEach(n => getEdgesConnectedTo(n).forEach(e => edgeSet.add(e)));
    const initialWaypoints = new Map([ ...edgeSet ].map(e => [ e, e.waypoints.map(p => ({ ...p })) ]));

    dragState = {
      nodes: draggedNodes,
      origins: draggedNodes.map(n => ({ x: n.x, y: n.y })),
      anchor: el,
      startAnchor: { x: el.x, y: el.y },
      offset: { x: p.x - el.x, y: p.y - el.y },
      initialWaypoints,
      moved: false
    };

    // The hover-edge connect handle is rooted at the drag-start
    // position; let it go now so it doesn't float in space while the
    // shape moves. It will reappear next time the cursor hovers a
    // shape's edge band.
    destroyConnectHandle();

    evt.stopPropagation();
    evt.preventDefault();
  }

  function onMouseMove(evt) {
    if (connectState) {
      const p = internals.toGraph(evt.clientX, evt.clientY);
      const hovered = elementAtPoint(evt.clientX, evt.clientY, { shapesOnly: true, skip: connectState.source });
      updateConnectPreview(p.x, p.y, hovered);
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
    if (labelDragState) {
      updateConnectionLabelDrag(evt);
      return;
    }
    if (!dragState) return;
    const p = internals.toGraph(evt.clientX, evt.clientY);
    const anchor = dragState.anchor;
    let newAnchorX = Math.round(p.x - dragState.offset.x);
    let newAnchorY = Math.round(p.y - dragState.offset.y);

    // Shift = constrain to dominant axis relative to drag origin
    if (evt.shiftKey) {
      const dxFromOrigin = newAnchorX - dragState.startAnchor.x;
      const dyFromOrigin = newAnchorY - dragState.startAnchor.y;
      if (Math.abs(dxFromOrigin) > Math.abs(dyFromOrigin)) {
        newAnchorY = dragState.startAnchor.y;
      } else {
        newAnchorX = dragState.startAnchor.x;
      }
    }

    // Snap: alignment with sibling shapes' edges & centres, then grid.
    const snap = computeSnap(anchor, newAnchorX, newAnchorY, dragState.nodes);
    newAnchorX = snap.x;
    newAnchorY = snap.y;
    drawAlignmentGuides(snap.guides);

    const dx = newAnchorX - anchor.x;
    const dy = newAnchorY - anchor.y;
    if (dx === 0 && dy === 0) return;
    dragState.nodes.forEach(n => setNodePosition(n, n.x + dx, n.y + dy));
    dragState.moved = true;
  }

  function elementAtPoint(clientX, clientY, opts = {}) {
    // Walk through the stack from topmost to lowest; skip:
    //   - bendpoint / resize / connect handles
    //   - the dragged element itself (if provided)
    //   - connection edges (when opts.shapesOnly)
    const stack = typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(clientX, clientY)
      : [ document.elementFromPoint(clientX, clientY) ].filter(Boolean);

    for (const target of stack) {
      if (!target) continue;
      // skip overlay handles
      if (target.classList && (
        target.classList.contains('bpmn-xyflow-bendpoint') ||
        target.classList.contains('bpmn-xyflow-resize-handle') ||
        target.classList.contains('bpmn-xyflow-connect-handle')
      )) continue;
      const id = internals.findElementId(target);
      if (!id) continue;
      const el = viewer.getElement(id);
      if (!el) continue;
      if (opts.skip && el === opts.skip) continue;
      if (opts.shapesOnly && el.waypoints) continue;
      return el;
    }
    return null;
  }

  function onMouseUp(evt) {
    if (connectState) {
      const node = elementAtPoint(evt.clientX, evt.clientY);
      endConnect(node && !node.waypoints ? node : null);
      return;
    }
    if (bendDragState) {
      endBendDrag(evt);
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
    if (labelDragState) {
      endConnectionLabelDrag();
      return;
    }
    if (!dragState) return;
    const { nodes, origins, initialWaypoints, moved } = dragState;
    dragState = null;
    clearAlignmentGuides();
    if (!moved) return;

    const finals = nodes.map(n => ({ x: n.x, y: n.y }));
    const finalWaypoints = new Map();
    initialWaypoints.forEach((_, edge) => {
      finalWaypoints.set(edge, edge.waypoints.map(p => ({ ...p })));
    });

    // Boundary-event attach: for any boundary event in the drag set,
    // detect whether its centre is now over an activity and update
    // host / attachedToRef accordingly.
    const boundaryUpdates = nodes
      .map(n => detectBoundaryAttach(n))
      .filter(Boolean);

    // Reparent: detect new parent container per moved node.
    const reparents = nodes
      .map(n => detectReparent(n))
      .filter(Boolean);

    commands.execute({
      name: 'move',
      do: () => {
        nodes.forEach((n, i) => setNodePositionRaw(n, finals[i].x, finals[i].y));
        finalWaypoints.forEach((wp, edge) => {
          edge.waypoints = wp.map(p => ({ ...p }));
          syncEdgeDi(edge);
          internals.redrawConnection(edge);
          if (bendpointEdge === edge) refreshBendpoints();
        });
        boundaryUpdates.forEach(applyBoundaryAttach);
        reparents.forEach(applyReparent);
        internals.refreshSelection();
        repositionContextPad();
        refreshResizeHandles();
      },
      undo: () => {
        nodes.forEach((n, i) => setNodePositionRaw(n, origins[i].x, origins[i].y));
        initialWaypoints.forEach((wp, edge) => {
          edge.waypoints = wp.map(p => ({ ...p }));
          syncEdgeDi(edge);
          internals.redrawConnection(edge);
          if (bendpointEdge === edge) refreshBendpoints();
        });
        boundaryUpdates.forEach(undoBoundaryAttach);
        reparents.forEach(undoReparent);
        internals.refreshSelection();
        repositionContextPad();
        refreshResizeHandles();
      }
    });
  }

  // Boundary-event attach detection ////
  function detectBoundaryAttach(node) {
    if (!node || !node.businessObject || !node.businessObject.$instanceOf) return null;
    if (!node.businessObject.$instanceOf('bpmn:BoundaryEvent')) return null;

    const graph = viewer.getGraph();
    if (!graph) return null;

    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;

    // find the activity whose bounds contain the boundary centre, or
    // whose perimeter is within ~6px of it
    let host = null;
    for (const cand of graph.nodes) {
      if (cand === node || cand.waypoints || cand.type === 'label') continue;
      if (!cand.businessObject || !cand.businessObject.$instanceOf) continue;
      if (!cand.businessObject.$instanceOf('bpmn:Activity')) continue;
      const inside = cx >= cand.x && cx <= cand.x + cand.width &&
                     cy >= cand.y && cy <= cand.y + cand.height;
      const nearEdge =
        cx >= cand.x - 8 && cx <= cand.x + cand.width + 8 &&
        cy >= cand.y - 8 && cy <= cand.y + cand.height + 8;
      if (inside || nearEdge) { host = cand; break; }
    }

    const oldHost = node.host || null;
    if (host === oldHost) return null;
    return { node, oldHost, newHost: host };
  }

  function applyBoundaryAttach({ node, newHost }) {
    if (node.host) {
      node.host.attachers = (node.host.attachers || []).filter(a => a !== node);
    }
    node.host = newHost || null;
    node.businessObject.attachedToRef = newHost ? newHost.businessObject : undefined;
    if (newHost) {
      newHost.attachers = newHost.attachers || [];
      if (!newHost.attachers.includes(node)) newHost.attachers.push(node);
    }
  }

  function undoBoundaryAttach({ node, oldHost }) {
    applyBoundaryAttach({ node, newHost: oldHost });
  }

  // Reparent detection /////////////////
  function detectReparent(node) {
    if (!node || !node.businessObject || !node.businessObject.$instanceOf) return null;
    // skip non-flow nodes and connections
    if (node.waypoints || node.type === 'label') return null;
    if (!node.businessObject.$instanceOf('bpmn:FlowNode') &&
        !node.businessObject.$instanceOf('bpmn:DataObjectReference') &&
        !node.businessObject.$instanceOf('bpmn:DataStoreReference')) return null;

    const graph = viewer.getGraph();
    if (!graph) return null;

    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;

    // find the smallest container under the centre (Lane > Participant > SubProcess)
    let bestParent = null;
    let bestArea = Infinity;
    for (const cand of graph.nodes) {
      if (cand === node || cand.waypoints || cand.type === 'label') continue;
      if (!canBeParent(cand, node)) continue;
      const inside = cx >= cand.x && cx <= cand.x + cand.width &&
                     cy >= cand.y && cy <= cand.y + cand.height;
      if (!inside) continue;
      const area = cand.width * cand.height;
      if (area < bestArea) { bestParent = cand; bestArea = area; }
    }

    const oldParent = node.parent || null;
    if (!bestParent || bestParent === oldParent) return null;
    return { node, oldParent, newParent: bestParent };
  }

  function applyReparent({ node, newParent }) {
    const oldParent = node.parent;
    if (oldParent) {
      oldParent.children = (oldParent.children || []).filter(c => c !== node);
    }
    node.parent = newParent;
    newParent.children = newParent.children || [];
    if (!newParent.children.includes(node)) newParent.children.push(node);

    const bo = node.businessObject;

    // Detach from any previous lanes' flowNodeRef arrays so the BPMN
    // doesn't end up referencing the same node from two lanes.
    const graph = viewer.getGraph();
    if (graph) {
      graph.nodes.forEach(other => {
        if (!other.businessObject || !other.businessObject.$instanceOf) return;
        if (!other.businessObject.$instanceOf('bpmn:Lane')) return;
        if (other === newParent) return;
        const refs = other.businessObject.flowNodeRef;
        if (Array.isArray(refs)) {
          const i = refs.indexOf(bo);
          if (i >= 0) refs.splice(i, 1);
        }
      });
    }

    // Resolve the eventual flowElements-owning container.
    const oldOwnerBo = bo.$parent;
    let newOwnerBo = newParent.businessObject;
    if (newOwnerBo && newOwnerBo.$instanceOf && newOwnerBo.$instanceOf('bpmn:Participant')) {
      newOwnerBo = newOwnerBo.processRef;
    }
    if (newOwnerBo && newOwnerBo.$instanceOf && newOwnerBo.$instanceOf('bpmn:Lane')) {
      // wire flowNodeRef on the new lane and walk up to the owning Process
      newOwnerBo.flowNodeRef = newOwnerBo.flowNodeRef || [];
      if (!newOwnerBo.flowNodeRef.includes(bo)) newOwnerBo.flowNodeRef.push(bo);
      let p = newOwnerBo.$parent;
      while (p && !p.$instanceOf('bpmn:Process')) p = p.$parent;
      newOwnerBo = p;
    }
    if (oldOwnerBo && newOwnerBo && oldOwnerBo !== newOwnerBo &&
        Array.isArray(oldOwnerBo.flowElements) && oldOwnerBo.flowElements.includes(bo)) {
      oldOwnerBo.flowElements = oldOwnerBo.flowElements.filter(e => e !== bo);
      newOwnerBo.flowElements = newOwnerBo.flowElements || [];
      if (!newOwnerBo.flowElements.includes(bo)) newOwnerBo.flowElements.push(bo);
      bo.$parent = newOwnerBo;
    }
  }

  function undoReparent({ node, oldParent, newParent }) {
    applyReparent({ node, newParent: oldParent });
    // applyReparent uses node.parent as oldParent reference; force-reset
    // by passing the original oldParent we captured.
    void newParent;
  }

  // Connect ////////////////////////
  let connectState = null;

  // an SVG <g> living in viewport that previews the in-flight connection
  let connectPreview = null;

  function startConnect(node, x, y) {
    destroyConnectHandle();
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

  function updateConnectPreview(x, y, hoveredTarget) {
    if (!connectPreview) return;
    const line = connectPreview.firstChild;
    line.setAttribute('x2', x);
    line.setAttribute('y2', y);
    // Colour the preview based on whether the cursor is over a valid
    // drop target. Bare cursor over empty canvas → neutral blue;
    // valid target → green; invalid target → red.
    let stroke = '#1a73e8';
    if (hoveredTarget && !hoveredTarget.waypoints && hoveredTarget !== connectState.source) {
      const inferred = getConnectionType(connectState.source, hoveredTarget);
      stroke = inferred ? '#2e7d32' : '#c62828';
    }
    line.setAttribute('stroke', stroke);
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

    // createConnection runs the rules; null means rejected
    createConnection(source, targetNode);
  }

  function ownerForConnection(connType, source, target) {
    const defs = viewer.getDefinitions();
    if (!defs) return null;
    if (connType === 'bpmn:MessageFlow') {
      // Message flows live on the collaboration
      const collab = (defs.rootElements || []).find(r => r.$type === 'bpmn:Collaboration');
      return collab || findOwningProcess();
    }
    // SequenceFlow / Association / DataAssociation owned by source's nearest
    // FlowElementsContainer (Process OR SubProcess), so a connection drawn
    // inside a SubProcess goes onto SubProcess.flowElements not the parent
    // Process's.
    let p = source.businessObject.$parent;
    while (p && !isFlowElementsContainer(p)) p = p.$parent;
    return p || findCurrentContainer();
  }

  function isFlowElementsContainer(bo) {
    if (!bo || typeof bo.$instanceOf !== 'function') return false;
    return bo.$instanceOf('bpmn:Process') || bo.$instanceOf('bpmn:SubProcess');
  }

  function ownerArrayForType(owner, connType) {
    if (!owner) return null;
    if (connType === 'bpmn:MessageFlow') {
      owner.messageFlows = owner.messageFlows || [];
      return owner.messageFlows;
    }
    if (connType === 'bpmn:Association') {
      // associations live on artifacts of the closest container
      owner.artifacts = owner.artifacts || [];
      return owner.artifacts;
    }
    owner.flowElements = owner.flowElements || [];
    return owner.flowElements;
  }

  /**
   * Create a connection between two shapes. The BPMN type is inferred
   * via the modeling rules unless `options.type` is supplied.
   *
   * Returns the new edge or `null` if the rules reject the pair.
   */
  function createConnection(source, target, options = {}) {
    const graph = viewer.getGraph();
    const defs = viewer.getDefinitions();
    if (!graph || !defs) return null;

    const connType = options.type || getConnectionType(source, target);
    if (!connType) return null;

    const owner = ownerForConnection(connType, source, target);
    if (!owner) return null;
    const ownerArray = ownerArrayForType(owner, connType);
    if (!ownerArray) return null;

    const id = nextId(connType.split(':')[1]);

    const boAttrs = { id };
    if (connType === 'bpmn:DataInputAssociation') {
      boAttrs.sourceRef = [ source.businessObject ];
      boAttrs.targetRef = target.businessObject;
    } else if (connType === 'bpmn:DataOutputAssociation') {
      boAttrs.sourceRef = source.businessObject;
      boAttrs.targetRef = target.businessObject;
    } else {
      boAttrs.sourceRef = source.businessObject;
      boAttrs.targetRef = target.businessObject;
    }

    const businessObject = moddle.create(connType, boAttrs);
    businessObject.$parent = owner;

    if (connType === 'bpmn:SequenceFlow') {
      // ensure the arrays exist so subsequent edits (delete, prune)
      // can rely on them
      source.businessObject.outgoing = source.businessObject.outgoing || [];
      target.businessObject.incoming = target.businessObject.incoming || [];
      source.businessObject.outgoing.push(businessObject);
      target.businessObject.incoming.push(businessObject);
    }

    // initial waypoints = source-mid → target-mid, cropped to outlines
    const initial = [ getMid(source), getMid(target) ];
    const bpmnRenderer = internals.renderer && internals.renderer.bpmnRenderer;
    const waypoints = bpmnRenderer
      ? cropWaypoints(initial, source, target, bpmnRenderer)
      : computeWaypoints(source, target);

    const plane = findCurrentPlane();
    const di = moddle.create('bpmndi:BPMNEdge', {
      id: id + '_di',
      bpmnElement: businessObject,
      waypoint: waypoints.map(p => moddle.create('dc:Point', { x: p.x, y: p.y }))
    });

    const edge = {
      id, type: connType, businessObject, di,
      source, target, waypoints,
      parent: source.parent, hidden: false
    };

    commands.execute({
      name: 'connect',
      do: () => {
        if (!graph.edges.includes(edge)) graph.edges.push(edge);
        graph.elementsById.set(edge.id, edge);
        if (!ownerArray.includes(businessObject)) ownerArray.push(businessObject);
        if (plane) {
          plane.planeElement = plane.planeElement || [];
          if (!plane.planeElement.includes(di)) plane.planeElement.push(di);
        }
        if (connType === 'bpmn:SequenceFlow') {
          source.businessObject.outgoing = source.businessObject.outgoing || [];
          target.businessObject.incoming = target.businessObject.incoming || [];
          if (!source.businessObject.outgoing.includes(businessObject)) source.businessObject.outgoing.push(businessObject);
          if (!target.businessObject.incoming.includes(businessObject)) target.businessObject.incoming.push(businessObject);
        }
        internals.redrawConnection(edge);
      },
      undo: () => {
        const idx = graph.edges.indexOf(edge);
        if (idx >= 0) graph.edges.splice(idx, 1);
        graph.elementsById.delete(edge.id);
        const oIdx = ownerArray.indexOf(businessObject);
        if (oIdx >= 0) ownerArray.splice(oIdx, 1);
        if (plane) {
          const dIdx = plane.planeElement.indexOf(di);
          if (dIdx >= 0) plane.planeElement.splice(dIdx, 1);
        }
        if (connType === 'bpmn:SequenceFlow') {
          if (Array.isArray(source.businessObject.outgoing)) {
            const i = source.businessObject.outgoing.indexOf(businessObject);
            if (i >= 0) source.businessObject.outgoing.splice(i, 1);
          }
          if (Array.isArray(target.businessObject.incoming)) {
            const i = target.businessObject.incoming.indexOf(businessObject);
            if (i >= 0) target.businessObject.incoming.splice(i, 1);
          }
        }
        internals.removeElementGfx(edge.id);
      }
    });

    return edge;
  }

  // Back-compat shim — older callers used createSequenceFlow.
  function createSequenceFlow(source, target) {
    return createConnection(source, target);
  }

  // Delete /////////////////////////
  /**
   * Remove the external-label graph node that the Importer created
   * for events / gateways / data objects. Pushed as its own command
   * so it joins the parent compound undo step.
   */
  /**
   * Build a fresh external-label graph node for `host` and render its
   * gfx in the labelLayer. If `existing` is supplied, reuse the same
   * label object (used by the rename undo path so the same node
   * identity comes back).
   */
  function createExternalLabelNode(host, text, boundsOrigin, existing) {
    const graph = viewer.getGraph();
    if (!graph) return null;
    const bounds = boundsOrigin
      ? { x: boundsOrigin.x, y: boundsOrigin.y, width: boundsOrigin.width, height: boundsOrigin.height }
      : { x: host.x + host.width / 2 - 45, y: host.y + host.height + 5, width: 90, height: 20 };
    const labelNode = existing || {
      id: host.id + '_label',
      type: 'label',
      businessObject: host.businessObject,
      di: host.di && host.di.label
        ? host.di.label
        : moddle.create('bpmndi:BPMNLabel', { bounds: moddle.create('dc:Bounds', bounds) }),
      labelTarget: host,
      hidden: false,
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      parent: host.parent,
      text
    };
    labelNode.text = text;
    if (!graph.nodes.includes(labelNode)) graph.nodes.push(labelNode);
    graph.elementsById.set(labelNode.id, labelNode);
    host.label = labelNode;

    // render gfx
    const layer = internals.svg.querySelector('.bpmn-xyflow-labels');
    if (layer) {
      const lgfx = svgCreate('g', {
        'class': 'bpmn-xyflow-label',
        'data-element-id': labelNode.id,
        transform: `translate(${ labelNode.x }, ${ labelNode.y })`
      });
      const tn = internals.renderer.textRenderer.createText(text || '', {
        box: { width: labelNode.width, height: labelNode.height },
        align: 'center-top',
        padding: 0,
        style: internals.renderer.textRenderer.getExternalStyle()
      });
      svgAppend(lgfx, tn);
      svgAppend(layer, lgfx);
    }
    return labelNode;
  }

  function removeExternalLabelNode(host, label) {
    const graph = viewer.getGraph();
    if (!graph) return;
    const i = graph.nodes.indexOf(label);
    if (i >= 0) graph.nodes.splice(i, 1);
    graph.elementsById.delete(label.id);
    host.label = null;
    internals.removeElementGfx(label.id);
  }

  function retextExternalLabelNode(label, text, boundsOrigin) {
    label.text = text;
    if (boundsOrigin) {
      label.x = Math.round(boundsOrigin.x);
      label.y = Math.round(boundsOrigin.y);
      label.width = Math.round(boundsOrigin.width);
      label.height = Math.round(boundsOrigin.height);
    }
    // re-render the gfx with the new text
    internals.removeElementGfx(label.id);
    const layer = internals.svg.querySelector('.bpmn-xyflow-labels');
    if (layer) {
      const lgfx = svgCreate('g', {
        'class': 'bpmn-xyflow-label',
        'data-element-id': label.id,
        transform: `translate(${ label.x }, ${ label.y })`
      });
      const tn = internals.renderer.textRenderer.createText(text || '', {
        box: { width: label.width, height: label.height },
        align: 'center-top',
        padding: 0,
        style: internals.renderer.textRenderer.getExternalStyle()
      });
      svgAppend(lgfx, tn);
      svgAppend(layer, lgfx);
    }
  }

  function deleteLabelNode(label) {
    const graph = viewer.getGraph();
    if (!graph || !label) return;
    const idx = graph.nodes.indexOf(label);
    if (idx < 0) return;
    const host = label.labelTarget;
    commands.execute({
      name: 'delete-label-node',
      do: () => {
        const i = graph.nodes.indexOf(label);
        if (i >= 0) graph.nodes.splice(i, 1);
        graph.elementsById.delete(label.id);
        if (host) host.label = null;
        internals.removeElementGfx(label.id);
      },
      undo: () => {
        graph.nodes.splice(idx, 0, label);
        graph.elementsById.set(label.id, label);
        if (host) host.label = label;
        // Re-create the label gfx by mirroring how renderGraph draws labels
        const text = label.text || (label.businessObject && label.businessObject.name) || '';
        const lgfx = svgCreate('g', {
          'class': 'bpmn-xyflow-label',
          'data-element-id': label.id,
          transform: `translate(${ label.x }, ${ label.y })`
        });
        const layer = internals.svg.querySelector('.bpmn-xyflow-labels');
        if (layer) {
          svgAppend(layer, lgfx);
          const tn = internals.renderer.textRenderer.createText(text, {
            box: { width: label.width, height: label.height },
            align: 'center-top',
            padding: 0,
            style: internals.renderer.textRenderer.getExternalStyle()
          });
          svgAppend(lgfx, tn);
        }
      }
    });
  }

  function deleteElement(element) {
    const graph = viewer.getGraph();
    const defs = viewer.getDefinitions();
    if (!graph || !defs) return;

    const isEdge = !!element.waypoints;

    if (isEdge) {
      const bo = element.businessObject;
      const owner = bo.$parent;
      const plane = findCurrentPlane();

      // Find the owner array regardless of connection type. We try
      // every well-known property name in turn.
      const ownerKeys = [ 'flowElements', 'messageFlows', 'artifacts' ];
      let oldOwnerKey = null;
      let oldOwnerIndex = -1;
      if (owner) {
        for (const k of ownerKeys) {
          const arr = owner[k];
          if (Array.isArray(arr)) {
            const i = arr.indexOf(bo);
            if (i >= 0) { oldOwnerKey = k; oldOwnerIndex = i; break; }
          }
        }
      }
      const oldDiIndex = plane && plane.planeElement ? plane.planeElement.indexOf(element.di) : -1;
      const oldEdgesIndex = graph.edges.indexOf(element);
      const sourceOutgoing = element.source.businessObject.outgoing;
      const targetIncoming = element.target.businessObject.incoming;
      const oldOutIndex = Array.isArray(sourceOutgoing) ? sourceOutgoing.indexOf(bo) : -1;
      const oldInIndex = Array.isArray(targetIncoming) ? targetIncoming.indexOf(bo) : -1;

      commands.execute({
        name: 'delete-edge',
        do: () => {
          if (oldOwnerKey && oldOwnerIndex >= 0) {
            const i = owner[oldOwnerKey].indexOf(bo);
            if (i >= 0) owner[oldOwnerKey].splice(i, 1);
          }
          if (plane && oldDiIndex >= 0) {
            const i = plane.planeElement.indexOf(element.di);
            if (i >= 0) plane.planeElement.splice(i, 1);
          }
          if (oldEdgesIndex >= 0) {
            const i = graph.edges.indexOf(element);
            if (i >= 0) graph.edges.splice(i, 1);
          }
          graph.elementsById.delete(element.id);
          if (Array.isArray(sourceOutgoing)) {
            const i = sourceOutgoing.indexOf(bo);
            if (i >= 0) sourceOutgoing.splice(i, 1);
          }
          if (Array.isArray(targetIncoming)) {
            const i = targetIncoming.indexOf(bo);
            if (i >= 0) targetIncoming.splice(i, 1);
          }
          internals.removeElementGfx(element.id);
          // Drop the deleted element from the active selection so its
          // overlays (selection marker, bendpoints, context pad,
          // resize handles) are torn down.
          viewer.deselect(element.id);
          // Connect handle is hover-bound, not selection-bound — kill
          // it explicitly if it was tracking this element so it
          // doesn't linger until the next mousemove.
          if (hoveredForConnect === element) destroyConnectHandle();
        },
        undo: () => {
          if (oldOwnerKey && oldOwnerIndex >= 0 && owner[oldOwnerKey] && !owner[oldOwnerKey].includes(bo)) {
            owner[oldOwnerKey].splice(oldOwnerIndex, 0, bo);
          }
          if (plane && oldDiIndex >= 0 && !plane.planeElement.includes(element.di)) {
            plane.planeElement.splice(oldDiIndex, 0, element.di);
          }
          if (oldEdgesIndex >= 0 && !graph.edges.includes(element)) {
            graph.edges.splice(oldEdgesIndex, 0, element);
          }
          graph.elementsById.set(element.id, element);
          if (Array.isArray(sourceOutgoing) && oldOutIndex >= 0 && !sourceOutgoing.includes(bo)) {
            sourceOutgoing.splice(oldOutIndex, 0, bo);
          }
          if (Array.isArray(targetIncoming) && oldInIndex >= 0 && !targetIncoming.includes(bo)) {
            targetIncoming.splice(oldInIndex, 0, bo);
          }
          internals.redrawConnection(element);
        }
      });
      return;
    }

    // shape: cascade-delete connected edges, attached boundary events,
    // and any external label node that belongs to this shape. All
    // collapsed into one composite undo step.
    const connected = getEdgesConnectedTo(element);
    const attachers = (element.attachers || []).slice();
    const labelNode = element.label || null;

    commands.compound('delete-shape', () => {
      connected.forEach(deleteElement);
      attachers.forEach(deleteElement);
      if (labelNode) deleteLabelNode(labelNode);

      const bo = element.businessObject;
      const owner = bo.$parent;
      const plane = findCurrentPlane();
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
          viewer.deselect(element.id);
          if (hoveredForConnect === element) destroyConnectHandle();
        },
        undo: () => {
          if (oldFlowIndex >= 0) owner.flowElements.splice(oldFlowIndex, 0, bo);
          if (plane && oldDiIndex >= 0) plane.planeElement.splice(oldDiIndex, 0, element.di);
          if (oldNodesIndex >= 0) graph.nodes.splice(oldNodesIndex, 0, element);
          graph.elementsById.set(element.id, element);
          internals.redrawShape(element);
        }
      });
    });
  }

  // Add ////////////////////////////
  function addShape(type, position) {
    const graph = viewer.getGraph();
    const defs = viewer.getDefinitions();
    if (!graph || !defs) return null;

    // Use the currently rendered container — Process at root level,
    // SubProcess after a drill-in.
    const owningProcess = findCurrentContainer();
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

    // External label DI for shapes that traditionally render their
    // name outside the body (events, gateways, data objects).
    if (hasExternalLabel(type)) {
      const labelBounds = moddle.create('dc:Bounds', {
        x: x + size.width / 2 - 45, y: y + size.height + 5,
        width: 90, height: 20
      });
      di.label = moddle.create('bpmndi:BPMNLabel', { bounds: labelBounds });
    }

    const plane = findCurrentPlane();
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

    // Scale the editor font with the current viewport zoom so it
    // matches the on-canvas glyph size at any zoom level.
    const zoom = (viewer.getViewport && viewer.getViewport().zoom) || 1;
    const fontSize = Math.max(8, Math.round(12 * zoom));

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
      font: `${ fontSize }px Arial, sans-serif`,
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

      // For shapes with external labels, ensure the di.label exists
      // and resize its bounds to fit the new text.
      const di = node.di;
      const renderer = internals.renderer && internals.renderer.bpmnRenderer;
      const textRenderer = renderer && internals.renderer.textRenderer;
      const isExternal = hasExternalLabel(node.type);

      let oldLabel = di && di.label;
      let newLabel = null;
      if (isExternal && textRenderer) {
        const baseBounds = (oldLabel && oldLabel.bounds) || moddle.create('dc:Bounds', {
          x: node.x + node.width / 2 - 45,
          y: node.y + node.height + 5,
          width: 90, height: 20
        });
        const fitted = textRenderer.getExternalLabelBounds(
          { x: baseBounds.x, y: baseBounds.y, width: baseBounds.width, height: baseBounds.height },
          newName
        );
        const fittedBounds = moddle.create('dc:Bounds', {
          x: Math.round(fitted.x), y: Math.round(fitted.y),
          width: Math.round(fitted.width), height: Math.round(fitted.height)
        });
        newLabel = moddle.create('bpmndi:BPMNLabel', { bounds: fittedBounds });
      }

      // Dispatch the redraw to the right layer — connections live
      // in connectionLayer; rendering them via redrawShape would
      // recreate the gfx in shapeLayer with broken pointer-events.
      const isEdge = !!node.waypoints;
      const redraw = isEdge
        ? () => internals.redrawConnection(node)
        : () => internals.redrawShape(node);

      // For external-label shapes we may need to create or remove a
      // label graph node. State machine over (had-label-before, has-name-now):
      //   ('', X)         + name X != '' && isExternal → create label node
      //   (X, '')         → remove existing label node
      //   (X, Y) X != Y   → just retext the existing label gfx
      const oldHadName = !!oldName && oldName.length > 0;
      const newHasName = !!newName && newName.length > 0;
      const labelExists = !!(node.label);
      const wantLabelNode = isExternal && newHasName;
      const labelNodeBefore = node.label || null;

      commands.execute({
        name: 'rename',
        do: () => {
          bo.name = newName;
          if (isExternal && di && newLabel) di.label = newLabel;
          redraw();
          if (wantLabelNode && !labelNodeBefore) {
            createExternalLabelNode(node, newName, newLabel && newLabel.bounds);
          } else if (!wantLabelNode && labelNodeBefore) {
            removeExternalLabelNode(node, labelNodeBefore);
          } else if (labelNodeBefore) {
            retextExternalLabelNode(labelNodeBefore, newName, newLabel && newLabel.bounds);
          }
        },
        undo: () => {
          bo.name = oldName;
          if (isExternal && di) di.label = oldLabel;
          redraw();
          // reverse the state-machine transition
          if (wantLabelNode && !labelNodeBefore) {
            // we created one — remove it
            if (node.label) removeExternalLabelNode(node, node.label);
          } else if (!wantLabelNode && labelNodeBefore) {
            // we removed one — restore it
            createExternalLabelNode(node, oldName, oldLabel && oldLabel.bounds, labelNodeBefore);
          } else if (labelNodeBefore) {
            retextExternalLabelNode(labelNodeBefore, oldName, oldLabel && oldLabel.bounds);
          }
        }
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
    if (!node) return;
    // Allow renaming connection labels too
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

  /**
   * Abort whatever drag-style gesture is currently in flight, restoring
   * pre-drag state without pushing a command. Returns true if it
   * cancelled something — caller should preventDefault in that case.
   */
  function cancelActiveGesture() {
    if (dragState) {
      // restore each node and its connected edges to pre-drag state
      const { nodes, origins, initialWaypoints } = dragState;
      nodes.forEach((n, i) => setNodePositionRaw(n, origins[i].x, origins[i].y));
      initialWaypoints.forEach((wp, edge) => {
        edge.waypoints = wp.map(p => ({ ...p }));
        syncEdgeDi(edge);
        internals.redrawConnection(edge);
      });
      dragState = null;
      clearAlignmentGuides();
      refreshSelectionMarkers();
      refreshResizeHandles();
      repositionContextPad();
      return true;
    }
    if (resizeDragState) {
      const { node, origin, anchors } = resizeDragState;
      node.x = origin.x; node.y = origin.y; node.width = origin.w; node.height = origin.h;
      if (node.di && node.di.bounds) {
        node.di.bounds.x = origin.x; node.di.bounds.y = origin.y;
        node.di.bounds.width = origin.w; node.di.bounds.height = origin.h;
      }
      internals.redrawShape(node);
      anchors.forEach(({ edge, originalWaypoints }) => {
        edge.waypoints = originalWaypoints.slice();
        syncEdgeDi(edge);
        internals.redrawConnection(edge);
      });
      resizeDragState = null;
      refreshResizeHandles();
      repositionContextPad();
      return true;
    }
    if (bendDragState) {
      const { edge, originalWaypoints } = bendDragState;
      edge.waypoints = originalWaypoints.slice();
      syncEdgeDi(edge);
      internals.redrawConnection(edge);
      refreshBendpoints();
      bendDragState = null;
      return true;
    }
    if (segmentDragState) {
      const { edge, originalWaypoints } = segmentDragState;
      edge.waypoints = originalWaypoints.slice();
      syncEdgeDi(edge);
      internals.redrawConnection(edge);
      refreshBendpoints();
      segmentDragState = null;
      return true;
    }
    if (connectState) {
      // no command pushed yet; just tear down the preview
      if (connectPreview && connectPreview.parentNode) connectPreview.parentNode.removeChild(connectPreview);
      connectPreview = null;
      connectState = null;
      return true;
    }
    if (labelDragState) {
      // restore the label gfx position
      labelDragState.host.setAttribute('transform', `translate(${ labelDragState.origin.x }, ${ labelDragState.origin.y })`);
      labelDragState = null;
      return true;
    }
    if (lassoState) {
      if (lassoRect && lassoRect.parentNode) lassoRect.parentNode.removeChild(lassoRect);
      lassoRect = null;
      lassoState = null;
      return true;
    }
    return false;
  }

  function onKeyDown(evt) {
    if (!opts.keyboard) return;

    // Don't capture keys when typing in the label editor
    if (labelEditor && labelEditor.contains(evt.target)) return;

    // Escape during an active gesture aborts and restores state.
    if (evt.key === 'Escape') {
      if (cancelActiveGesture()) {
        evt.preventDefault();
        return;
      }
    }

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
    if (isCtrl && evt.key.toLowerCase() === 'a') {
      const graph = viewer.getGraph();
      if (!graph) return;
      const ids = [
        ...graph.nodes.filter(n => !n.hidden && n.type !== 'label' && 'x' in n).map(n => n.id),
        ...graph.edges.filter(e => !e.hidden).map(e => e.id)
      ];
      viewer.select(ids);
      evt.preventDefault();
      return;
    }
    if (evt.key === 'Delete' || evt.key === 'Backspace') {
      const ids = viewer.getSelection();
      if (!ids.length) return;
      // collapse multi-element delete into a single undo step
      commands.compound('delete-multi', () => {
        ids.map(id => viewer.getElement(id)).filter(Boolean).forEach(deleteElement);
      });
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

      const moves = nodes.map(n => ({ node: n, from: { x: n.x, y: n.y }, to: { x: n.x + dx, y: n.y + dy } }));

      // snapshot connected-edge waypoints before/after the move
      const edgeSet = new Set();
      nodes.forEach(n => getEdgesConnectedTo(n).forEach(e => edgeSet.add(e)));
      const before = new Map([ ...edgeSet ].map(e => [ e, e.waypoints.map(p => ({ ...p })) ]));
      moves.forEach(m => setNodePosition(m.node, m.to.x, m.to.y));
      const after = new Map([ ...edgeSet ].map(e => [ e, e.waypoints.map(p => ({ ...p })) ]));
      // revert; the command will re-apply on do
      moves.forEach(m => setNodePositionRaw(m.node, m.from.x, m.from.y));
      before.forEach((wp, edge) => {
        edge.waypoints = wp.map(p => ({ ...p }));
        syncEdgeDi(edge);
        internals.redrawConnection(edge);
      });

      commands.execute({
        name: 'arrow-move',
        do: () => {
          moves.forEach(m => setNodePositionRaw(m.node, m.to.x, m.to.y));
          after.forEach((wp, edge) => {
            edge.waypoints = wp.map(p => ({ ...p }));
            syncEdgeDi(edge);
            internals.redrawConnection(edge);
            if (bendpointEdge === edge) refreshBendpoints();
          });
          internals.refreshSelection();
          repositionContextPad();
          refreshResizeHandles();
        },
        undo: () => {
          moves.forEach(m => setNodePositionRaw(m.node, m.from.x, m.from.y));
          before.forEach((wp, edge) => {
            edge.waypoints = wp.map(p => ({ ...p }));
            syncEdgeDi(edge);
            internals.redrawConnection(edge);
            if (bendpointEdge === edge) refreshBendpoints();
          });
          internals.refreshSelection();
          repositionContextPad();
          refreshResizeHandles();
        }
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

  // counter so a sequence of Cmd+V keypresses doesn't pile every paste
  // onto identical coords
  let pastesSinceCopy = 0;

  function copySelection() {
    pastesSinceCopy = 0;
    const ids = viewer.getSelection();
    const elements = ids.map(id => viewer.getElement(id)).filter(Boolean);
    if (!elements.length) { clipboard = null; return; }
    const shapes = elements.filter(e => !e.waypoints);
    const shapeIds = new Set(shapes.map(s => s.id));
    // include any selected edge whose source AND target are also in the
    // selection. We also include implicit edges between selected shapes
    // even when not explicitly selected — matches bpmn-js's "copy with
    // their relationships" UX.
    const graph = viewer.getGraph();
    const allEdges = (graph && graph.edges) || [];
    const edges = allEdges.filter(e =>
      shapeIds.has(e.source.id) && shapeIds.has(e.target.id)
    );
    clipboard = {
      shapes: shapes.map(el => ({
        id: el.id,
        type: el.type,
        width: el.width,
        height: el.height,
        x: el.x, y: el.y,
        name: el.businessObject.name
      })),
      edges: edges.map(e => ({
        type: e.type,
        sourceId: e.source.id,
        targetId: e.target.id,
        name: e.businessObject.name,
        waypoints: e.waypoints.map(p => ({ x: p.x, y: p.y }))
      }))
    };
  }

  function pasteAtPoint(clientX, clientY) {
    if (!clipboard || !clipboard.shapes || !clipboard.shapes.length) return;
    const p = internals.toGraph(clientX, clientY);
    // place clipboard's centroid at the paste point, offset by 20px
    // per repeated paste so duplicates don't stack
    pastesSinceCopy += 1;
    const incr = (pastesSinceCopy - 1) * 20;
    const cx = clipboard.shapes.reduce((s, c) => s + c.x + c.width / 2, 0) / clipboard.shapes.length;
    const cy = clipboard.shapes.reduce((s, c) => s + c.y + c.height / 2, 0) / clipboard.shapes.length;
    const dx = (p.x - cx) + incr;
    const dy = (p.y - cy) + incr;

    const idMap = new Map();
    const newIds = [];
    // single composite undo step covering all pasted shapes + edges
    commands.compound('paste', () => {
      clipboard.shapes.forEach(c => {
        const node = addShape(c.type, { x: c.x + c.width / 2 + dx, y: c.y + c.height / 2 + dy });
        if (!node) return;
        if (c.name) {
          node.businessObject.name = c.name;
          internals.redrawShape(node);
        }
        idMap.set(c.id, node);
        newIds.push(node.id);
      });
      (clipboard.edges || []).forEach(e => {
        const src = idMap.get(e.sourceId);
        const tgt = idMap.get(e.targetId);
        if (src && tgt) {
          const newEdge = createConnection(src, tgt, { type: e.type });
          if (newEdge && e.name) {
            newEdge.businessObject.name = e.name;
            internals.redrawConnection(newEdge);
          }
        }
      });
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

    // Allow type-stable event-def swaps (same family, different
    // eventDefinition).
    const eventDefType = attrs.__eventDefinition;
    const wantsEventDefSwap = eventDefType !== undefined;
    if (element.type === newType && !wantsEventDefSwap) return element;

    const oldBo = element.businessObject;
    const owner = oldBo.$parent;
    const plane = findCurrentPlane();
    const oldType = element.type;
    const oldDi = element.di;

    // create the new business object, copy commonly preserved fields
    const cleanAttrs = Object.assign({}, attrs);
    delete cleanAttrs.__eventDefinition;
    const newBo = moddle.create(newType, Object.assign({
      id: oldBo.id,
      name: oldBo.name
    }, cleanAttrs));
    newBo.$parent = owner;

    // Event-definition handling: null clears all defs, otherwise
    // replace the eventDefinitions array with a single instance of
    // the requested type.
    if (wantsEventDefSwap) {
      if (eventDefType === null) {
        newBo.eventDefinitions = [];
      } else {
        const def = moddle.create(eventDefType, {});
        def.$parent = newBo;
        newBo.eventDefinitions = [ def ];
      }
    } else if (Array.isArray(oldBo.eventDefinitions) && oldBo.eventDefinitions.length) {
      // preserve existing defs on a plain family swap
      newBo.eventDefinitions = oldBo.eventDefinitions.slice();
    }

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

    // Capture the old outgoing/incoming arrays so undo can restore
    // exactly. Newly minted newBo starts with empty arrays which we
    // populate below with the same edge bos.
    const oldBoOutgoing = Array.isArray(oldBo.outgoing) ? oldBo.outgoing.slice() : null;
    const oldBoIncoming = Array.isArray(oldBo.incoming) ? oldBo.incoming.slice() : null;

    commands.execute({
      name: 'replace-shape',
      do: () => {
        if (flowIdx >= 0) owner.flowElements[flowIdx] = newBo;
        if (plane && diIdx >= 0) plane.planeElement[diIdx] = newDi;
        element.type = newType;
        element.businessObject = newBo;
        element.di = newDi;
        // re-point edge refs AND maintain the new bo's outgoing/incoming
        newBo.outgoing = newBo.outgoing || [];
        newBo.incoming = newBo.incoming || [];
        outgoing.forEach(e => {
          e.businessObject.sourceRef = newBo;
          if (!newBo.outgoing.includes(e.businessObject)) newBo.outgoing.push(e.businessObject);
        });
        incoming.forEach(e => {
          e.businessObject.targetRef = newBo;
          if (!newBo.incoming.includes(e.businessObject)) newBo.incoming.push(e.businessObject);
        });
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
        // restore oldBo's outgoing/incoming exactly
        if (oldBoOutgoing) oldBo.outgoing = oldBoOutgoing.slice();
        if (oldBoIncoming) oldBo.incoming = oldBoIncoming.slice();
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

  // Activity markers ///////////////
  function toggleActivityMarker(activity, marker) {
    if (!activity || !activity.businessObject || !activity.businessObject.$instanceOf) return;
    const bo = activity.businessObject;
    if (!bo.$instanceOf('bpmn:Activity')) return;

    const before = {
      isForCompensation: !!bo.isForCompensation,
      loopCharacteristics: bo.loopCharacteristics
    };

    let after;
    if (marker === 'compensation') {
      after = {
        isForCompensation: !before.isForCompensation,
        loopCharacteristics: before.loopCharacteristics
      };
    } else if (marker === 'loop' || marker === 'parallelMI' || marker === 'sequentialMI') {
      const current = before.loopCharacteristics;
      const isLoop = current && current.$instanceOf && current.$instanceOf('bpmn:StandardLoopCharacteristics');
      const isMi = current && current.$instanceOf && current.$instanceOf('bpmn:MultiInstanceLoopCharacteristics');
      const wantedKind = marker === 'loop' ? 'loop'
                        : marker === 'parallelMI' ? 'parallelMI'
                        : 'sequentialMI';
      const currentKind = isLoop ? 'loop'
                          : (isMi ? (current.isSequential ? 'sequentialMI' : 'parallelMI') : null);
      let next = null;
      if (currentKind !== wantedKind) {
        if (wantedKind === 'loop') {
          next = moddle.create('bpmn:StandardLoopCharacteristics', {});
        } else {
          next = moddle.create('bpmn:MultiInstanceLoopCharacteristics', {
            isSequential: wantedKind === 'sequentialMI'
          });
        }
        next.$parent = bo;
      }
      after = { isForCompensation: before.isForCompensation, loopCharacteristics: next };
    } else {
      return;
    }

    commands.execute({
      name: 'toggle-marker',
      do: () => {
        bo.isForCompensation = after.isForCompensation;
        bo.loopCharacteristics = after.loopCharacteristics;
        internals.redrawShape(activity);
      },
      undo: () => {
        bo.isForCompensation = before.isForCompensation;
        bo.loopCharacteristics = before.loopCharacteristics;
        internals.redrawShape(activity);
      }
    });
  }

  // Sub-process drill-in / collapse
  function toggleSubProcessExpanded(node) {
    if (!node || !node.di) return;
    const before = node.di.isExpanded;
    const after = before === false ? true : false;
    const descendants = collectDescendants(node);

    commands.execute({
      name: 'toggle-expanded',
      do: () => {
        node.di.isExpanded = after;
        node.collapsed = after === false;
        applyHiddenForDescendants(descendants, after === false);
        internals.redrawShape(node);
      },
      undo: () => {
        node.di.isExpanded = before;
        node.collapsed = before === false;
        applyHiddenForDescendants(descendants, before === false);
        internals.redrawShape(node);
      }
    });
  }

  // Collect every shape AND every connection internal to a sub-process,
  // recursively. We treat children (graph link) as the source of truth
  // for shapes; for connections we include any whose source AND target
  // are inside the descendant set.
  function collectDescendants(root) {
    const shapes = new Set();
    function walk(node) {
      (node.children || []).forEach(c => {
        if (c === root) return;
        shapes.add(c);
        walk(c);
      });
    }
    walk(root);
    const graph = viewer.getGraph();
    const edges = (graph && graph.edges || []).filter(e =>
      shapes.has(e.source) && shapes.has(e.target)
    );
    return { shapes: [ ...shapes ], edges };
  }

  function applyHiddenForDescendants({ shapes, edges }, hidden) {
    shapes.forEach(n => {
      n.hidden = hidden;
      if (hidden) internals.removeElementGfx(n.id);
      else internals.redrawShape(n);
    });
    edges.forEach(e => {
      e.hidden = hidden;
      if (hidden) internals.removeElementGfx(e.id);
      else internals.redrawConnection(e);
    });
  }

  // Per-level navigation: each entry is { diagramId, history } so each
  // level has its own undo stack.
  const navStack = [];
  let currentDiagramId = null;

  async function drillInto(subProcessNode) {
    if (!subProcessNode || !subProcessNode.businessObject) return;
    const defs = viewer.getDefinitions();
    if (!defs) return;
    const bo = subProcessNode.businessObject;

    // Find or synthesise a diagram for the sub-process plane
    let diagram = (defs.diagrams || []).find(d => d.plane && d.plane.bpmnElement === bo);
    if (!diagram) {
      const plane = moddle.create('bpmndi:BPMNPlane', {
        id: bo.id + '_plane',
        bpmnElement: bo,
        planeElement: []
      });
      diagram = moddle.create('bpmndi:BPMNDiagram', {
        id: bo.id + '_di_diagram',
        plane
      });
      defs.diagrams = defs.diagrams || [];
      defs.diagrams.push(diagram);
    }

    // Push current level (diagram + command history) onto the stack
    navStack.push({
      diagramId: currentDiagramId || (defs.diagrams[0] && defs.diagrams[0].id),
      history: commands.snapshot()
    });
    commands.clear();
    currentDiagramId = diagram.id;
    await viewer.switchDiagram(diagram.id);
  }

  async function navigateBack() {
    if (!navStack.length) return;
    const prev = navStack.pop();
    commands.restore(prev.history);
    currentDiagramId = prev.diagramId;
    await viewer.switchDiagram(prev.diagramId);
  }

  // Public modeling API ////////////
  const self = this;
  this.addShape = addShape;
  this.connect = createConnection;
  this.delete = deleteElement;
  this.replace = replaceShape;
  this.toggleMarker = toggleActivityMarker;
  this.toggleExpanded = toggleSubProcessExpanded;
  this.drillInto = drillInto;
  this.navigateBack = navigateBack;
  this.canNavigateBack = () => navStack.length > 0;
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
