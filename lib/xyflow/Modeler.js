/* eslint-env browser */

import {
  append as svgAppend,
  attr as svgAttr,
  create as svgCreate
} from 'tiny-svg';

import { BpmnModdle } from 'bpmn-moddle';

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

  // wire show/hide to selection
  viewer.on('selection.change', ({ ids }) => {
    if (ids.length === 1) {
      const el = viewer.getElement(ids[0]);
      if (el && el.waypoints) {
        showBendpoints(el);
        return;
      }
    }
    hideBendpoints();
  });

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
    if (connectState || dragState || bendDragState) return;

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
    if (!el) return;
    if (el.type === 'label') return;

    // 2. mousedown on a selected connection's line → insert a new
    //    bendpoint at the click point and start dragging it
    if (el.waypoints) {
      if (bendpointEdge !== el) return;
      const p = internals.toGraph(evt.clientX, evt.clientY);
      // find the nearest segment and insert there
      let bestIdx = 1, bestDist = Infinity;
      for (let i = 0; i < el.waypoints.length - 1; i++) {
        const d = pointToSegmentDist(p, el.waypoints[i], el.waypoints[i + 1]);
        if (d < bestDist) { bestDist = d; bestIdx = i + 1; }
      }
      const original = el.waypoints.slice();
      el.waypoints.splice(bestIdx, 0, { x: p.x, y: p.y });
      syncEdgeDi(el);
      internals.redrawConnection(el);
      refreshBendpoints();
      startBendDrag(el, bestIdx, original, true);
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

    dragState = {
      node: el,
      origin: { x: el.x, y: el.y },
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
    if (!dragState) return;
    const p = internals.toGraph(evt.clientX, evt.clientY);
    const newX = Math.round(p.x - dragState.offset.x);
    const newY = Math.round(p.y - dragState.offset.y);
    if (newX !== dragState.node.x || newY !== dragState.node.y) {
      setNodePosition(dragState.node, newX, newY);
      dragState.moved = true;
    }
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
    if (!dragState) return;
    const { node, origin, moved } = dragState;
    dragState = null;
    if (!moved) return;

    const finalPos = { x: node.x, y: node.y };

    // capture old waypoints to restore on undo
    const edges = getEdgesConnectedTo(node);
    const oldWaypoints = new Map(edges.map(e => [ e, e.waypoints.slice() ]));

    commands.execute({
      name: 'move',
      do: () => {
        setNodePosition(node, finalPos.x, finalPos.y);
      },
      undo: () => {
        setNodePosition(node, origin.x, origin.y);
        // restore exact waypoints (don't just reroute, in case of custom waypoints)
        for (const [ edge, wp ] of oldWaypoints) {
          edge.waypoints = wp;
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

    const waypoints = computeWaypoints(source, target);

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
      Object.assign(btn.style, {
        padding: '4px 8px',
        textAlign: 'left',
        cursor: 'pointer',
        border: '1px solid #ddd',
        borderRadius: '3px',
        background: 'white',
        font: 'inherit'
      });
      btn.addEventListener('click', () => {
        // place near the centre of the current viewport
        const v = viewer.getViewport();
        const rect = viewer.getContainer().getBoundingClientRect();
        const center = {
          x: (rect.width / 2 - v.x) / v.zoom,
          y: (rect.height / 2 - v.y) / v.zoom
        };
        // jitter so consecutive clicks don't pile up
        center.x += (Math.random() - 0.5) * 80;
        center.y += (Math.random() - 0.5) * 60;
        const node = addShape(item.type, center);
        if (node) viewer.select(node.id);
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
    if (evt.key === 'Delete' || evt.key === 'Backspace') {
      const ids = viewer.getSelection();
      if (!ids.length) return;
      ids.map(id => viewer.getElement(id)).filter(Boolean).forEach(deleteElement);
      viewer.clearSelection();
      evt.preventDefault();
    }
  }

  // build palette once mounted (container already exists at this point)
  buildPalette();

  // Public modeling API ////////////
  this.addShape = addShape;
  this.connect = createSequenceFlow;
  this.delete = deleteElement;
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
