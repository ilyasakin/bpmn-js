import {
  XYPanZoom,
  XYMinimap,
  PanOnScrollMode,
  getViewportForBounds
} from '@xyflow/system';

import {
  append as svgAppend,
  attr as svgAttr,
  create as svgCreate,
  classes as svgClasses,
  clear as svgClear
} from 'tiny-svg';

import { parseBpmnXML, buildGraph } from './Importer';
import Renderer from './Renderer';

const SVG_NS = 'http://www.w3.org/2000/svg';

const NOOP = function() {};

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return String(value).replace(/(["\\\]\[\(\)\.\#\>\+\~\*\^\$\|\{\}\,\:\;\=\@\!])/g, '\\$1');
}

// Mid-of-longest-segment heuristic for placing a connection label.
function pickLabelPosition(waypoints) {
  let best = { dx: 0, dy: 0 };
  let bestLen = -1;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > bestLen) {
      bestLen = len;
      best = { x: (a.x + b.x) / 2 - 45, y: (a.y + b.y) / 2 - 25 };
    }
  }
  return best;
}

const DEFAULT_OPTIONS = {
  minZoom: 0.2,
  maxZoom: 4,
  fitPadding: 20,
  fitViewOnInit: true,
  refitOnResize: true,
  keyboard: true,
  minimap: false
};

const DEFAULT_MINIMAP = {
  width: 200,
  height: 150,
  position: 'bottom-right',
  margin: 10,
  background: 'rgba(255, 255, 255, 0.85)',
  border: '1px solid rgba(0, 0, 0, 0.1)',
  nodeFill: '#cbd2d8',
  viewportFill: 'rgba(26, 115, 232, 0.15)',
  viewportStroke: '#1a73e8'
};

function ensureSvgRoot(container) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.style.display = 'block';
  svg.style.userSelect = 'none';
  svg.style.touchAction = 'none';
  return svg;
}

function appendChildSvg(parent, child) {
  parent.appendChild(child);
}

/**
 * A read-only BPMN viewer powered by @xyflow/system for pan/zoom and
 * the bpmn-js renderer for shapes.
 *
 * @param {Object} options
 * @param {HTMLElement} options.container DOM element to mount the viewer in
 * @param {Object} [options.config] Renderer config (colors, fonts)
 * @param {number} [options.minZoom]
 * @param {number} [options.maxZoom]
 * @param {number} [options.fitPadding]
 * @param {boolean} [options.fitViewOnInit]
 */
export default function BpmnXyflowViewer(options = {}) {
  const opts = Object.assign({}, DEFAULT_OPTIONS, options);
  const container = opts.container;

  if (!container) {
    throw new Error('options.container is required');
  }

  container.style.position = container.style.position || 'relative';
  container.style.overflow = 'hidden';

  const svg = ensureSvgRoot(container);
  appendChildSvg(container, svg);

  // viewport <g> that gets transformed by XYPanZoom
  const viewport = document.createElementNS(SVG_NS, 'g');
  viewport.setAttribute('class', 'bpmn-xyflow-viewport');
  svg.appendChild(viewport);

  // separate layers so connections render above shapes,
  // labels above connections
  const shapeLayer = document.createElementNS(SVG_NS, 'g');
  shapeLayer.setAttribute('class', 'bpmn-xyflow-shapes');
  viewport.appendChild(shapeLayer);

  const connectionLayer = document.createElementNS(SVG_NS, 'g');
  connectionLayer.setAttribute('class', 'bpmn-xyflow-connections');
  viewport.appendChild(connectionLayer);

  const labelLayer = document.createElementNS(SVG_NS, 'g');
  labelLayer.setAttribute('class', 'bpmn-xyflow-labels');
  viewport.appendChild(labelLayer);

  const renderer = new Renderer({
    rootSvg: svg,
    config: opts.config
  });

  let panZoom;
  let currentGraph = null;
  let currentDefinitions = null;
  let currentViewport = { x: 0, y: 0, zoom: 1 };

  // Event listeners /////////////
  const listeners = new Map();

  function on(type, handler) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
    return () => off(type, handler);
  }

  function off(type, handler) {
    const set = listeners.get(type);
    if (set) set.delete(handler);
  }

  function emit(type, payload) {
    const set = listeners.get(type);
    if (!set) return;
    for (const h of set) {
      try { h(payload); } catch (e) { console.error(`listener for ${ type } threw`, e); }
    }
  }

  // Selection state /////////////
  const selection = new Set();

  function elementGfx(id) {
    return viewport.querySelector(`[data-element-id="${ cssEscape(id) }"]`);
  }

  function applySelectionClass(id, on) {
    const gfx = elementGfx(id);
    if (gfx) {
      if (on) gfx.classList.add('is-selected');
      else gfx.classList.remove('is-selected');
    }
  }

  /**
   * Render (or re-render) a connection edge into the connection layer.
   * Includes the connection name label if `edge.businessObject.name`
   * is set; the label position priority is:
   *   1. `edge.di.label.bounds` (persists across export/import)
   *   2. longest-segment midpoint heuristic
   *
   * Shared by the initial render path (drawConnectionEdge) and any
   * later updates (internals.redrawConnection).
   */
  function drawConnectionInto(edge) {
    const old = elementGfx(edge.id);
    if (old) old.parentNode.removeChild(old);
    if (edge.hidden) return;

    const g = svgCreate('g', {
      'class': 'bpmn-xyflow-connection',
      'data-element-id': edge.id
    });
    svgAppend(connectionLayer, g);

    try {
      renderer.drawConnection(g, edge);
    } catch (e) {
      console.warn('drawConnection', edge.id, e);
    }

    const name = edge.businessObject && edge.businessObject.name;
    if (name && edge.waypoints && edge.waypoints.length >= 2) {
      const diLabelBounds = edge.di && edge.di.label && edge.di.label.bounds;
      const labelPos = diLabelBounds
        ? { x: diLabelBounds.x, y: diLabelBounds.y, width: diLabelBounds.width, height: diLabelBounds.height }
        : Object.assign({ width: 90, height: 20 }, pickLabelPosition(edge.waypoints));

      const labelG = svgCreate('g', {
        'class': 'bpmn-xyflow-connection-label',
        'data-element-id': edge.id,
        'data-connection-label': 'true',
        transform: `translate(${ labelPos.x }, ${ labelPos.y })`
      });
      labelG.style.cursor = 'move';

      const text = renderer.textRenderer.createText(name, {
        box: { width: labelPos.width, height: labelPos.height },
        align: 'center-middle',
        padding: 0,
        style: renderer.textRenderer.getExternalStyle()
      });
      svgClasses(text).add('djs-label');
      svgAppend(labelG, text);
      svgAppend(g, labelG);
    }
    return g;
  }

  function setSelection(ids) {
    const next = new Set(ids);

    // remove old
    for (const id of selection) {
      if (!next.has(id)) applySelectionClass(id, false);
    }
    // add new
    for (const id of next) {
      if (!selection.has(id)) applySelectionClass(id, true);
    }

    const changed = next.size !== selection.size ||
      [ ...next ].some(id => !selection.has(id));

    selection.clear();
    next.forEach(id => selection.add(id));

    if (changed) {
      emit('selection.change', {
        ids: [ ...selection ],
        elements: [ ...selection ].map(id => currentGraph?.elementsById.get(id)).filter(Boolean)
      });
    }
  }

  function findElementId(target) {
    let node = target;
    while (node && node !== svg) {
      if (node.getAttribute && node.getAttribute('data-element-id')) {
        return node.getAttribute('data-element-id');
      }
      node = node.parentNode;
    }
    return null;
  }

  function getElement(id) {
    return (currentGraph && currentGraph.elementsById.get(id)) || null;
  }

  function attachInteractionListeners() {
    // pointerup → click (works through panZoom drag because XYPanZoom uses
    // d3-zoom which doesn't preventDefault on click unless dragging happened)
    let pointerDownPos = null;

    svg.addEventListener('pointerdown', (evt) => {
      pointerDownPos = { x: evt.clientX, y: evt.clientY };
      // focus svg so keyboard shortcuts work
      if (opts.keyboard && document.activeElement !== svg) svg.focus({ preventScroll: true });
    });

    svg.addEventListener('pointerup', (evt) => {
      if (!pointerDownPos) return;
      const dx = evt.clientX - pointerDownPos.x;
      const dy = evt.clientY - pointerDownPos.y;
      pointerDownPos = null;

      // ignore if user dragged (panned) — threshold ~3px
      if (Math.hypot(dx, dy) > 3) return;

      const id = findElementId(evt.target);
      const element = id ? getElement(id) : null;
      emit('element.click', { event: evt, element, id });

      if (opts.selectOnClick !== false) {
        if (id) {
          if (evt.shiftKey || evt.metaKey || evt.ctrlKey) {
            const next = new Set(selection);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            setSelection(next);
          } else {
            setSelection([ id ]);
          }
        } else {
          setSelection([]);
        }
      }
    });

    let hoveredId = null;
    svg.addEventListener('pointermove', (evt) => {
      const id = findElementId(evt.target);
      if (id === hoveredId) return;

      if (hoveredId) {
        const prev = elementGfx(hoveredId);
        if (prev) prev.classList.remove('is-hovered');
        emit('element.out', { event: evt, id: hoveredId, element: getElement(hoveredId) });
      }
      if (id) {
        const next = elementGfx(id);
        if (next) next.classList.add('is-hovered');
        emit('element.hover', { event: evt, id, element: getElement(id) });
      }
      hoveredId = id;
    });

    svg.addEventListener('pointerleave', (evt) => {
      if (hoveredId) {
        const prev = elementGfx(hoveredId);
        if (prev) prev.classList.remove('is-hovered');
        emit('element.out', { event: evt, id: hoveredId, element: getElement(hoveredId) });
        hoveredId = null;
      }
    });
  }

  // inject minimal styles for hover/selection
  const styleEl = document.createElementNS(SVG_NS, 'style');
  styleEl.textContent = `
    .bpmn-xyflow-shape, .bpmn-xyflow-connection { cursor: pointer; }
    .bpmn-xyflow-shape.is-hovered :is(rect, circle, polygon, path):not([data-marker]) {
      stroke: #1a73e8;
    }
    .bpmn-xyflow-connection.is-hovered path:not([data-marker]) {
      stroke: #1a73e8;
    }
    .bpmn-xyflow-shape.is-selected :is(rect, circle, polygon, path):not([data-marker]) {
      stroke: #1a73e8;
      stroke-width: 3;
    }
    .bpmn-xyflow-connection.is-selected path:not([data-marker]) {
      stroke: #1a73e8;
      stroke-width: 3;
    }
  `;
  svg.appendChild(styleEl);

  attachInteractionListeners();

  // Track whether the user has interacted with the viewport since the
  // last fitView/import. We only refit on resize while this is false.
  let userTouchedViewport = false;
  on('viewport.change', () => { userTouchedViewport = true; });

  // Resize observer //////////////
  let resizeObserver;
  if (typeof ResizeObserver !== 'undefined' && opts.refitOnResize) {
    let firstObservation = true;
    resizeObserver = new ResizeObserver(() => {
      if (firstObservation) { firstObservation = false; return; }
      if (!currentGraph) return;
      if (!userTouchedViewport) {
        fitView();
      }
    });
    resizeObserver.observe(container);
  }

  // Keyboard shortcuts //////////
  function handleKey(evt) {
    if (!opts.keyboard) return;

    // skip when typing in inputs / textareas
    const tag = evt.target && evt.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (evt.target && evt.target.isContentEditable)) {
      return;
    }

    if (evt.key === '+' || evt.key === '=') {
      panZoom?.scaleBy(1.2);
      evt.preventDefault();
    } else if (evt.key === '-' || evt.key === '_') {
      panZoom?.scaleBy(1 / 1.2);
      evt.preventDefault();
    } else if (evt.key === '0') {
      const v = { x: 0, y: 0, zoom: 1 };
      panZoom?.setViewport(v, { duration: 0 });
      setViewportTransform(v);
      evt.preventDefault();
    } else if (evt.key === 'f' || evt.key === 'F') {
      fitView();
      evt.preventDefault();
    } else if (evt.key === 'Escape') {
      setSelection([]);
    }
  }

  // bind to the SVG so other inputs on the page aren't captured;
  // make the SVG focusable so it can actually receive keys
  svg.setAttribute('tabindex', '0');
  svg.style.outline = 'none';
  svg.addEventListener('keydown', handleKey);

  // Minimap //////////////////////
  let minimap = null;
  let minimapApi = null;
  let minimapNodesG = null;
  let minimapViewportRect = null;
  let minimapConfig = null;

  function ensureMinimap() {
    if (!opts.minimap || minimap) return;

    minimapConfig = Object.assign({}, DEFAULT_MINIMAP, opts.minimap === true ? {} : opts.minimap);

    minimap = document.createElementNS(SVG_NS, 'svg');
    minimap.setAttribute('class', 'bpmn-xyflow-minimap');
    minimap.setAttribute('width', minimapConfig.width);
    minimap.setAttribute('height', minimapConfig.height);
    Object.assign(minimap.style, {
      position: 'absolute',
      bottom: minimapConfig.position.includes('bottom') ? minimapConfig.margin + 'px' : '',
      top: minimapConfig.position.includes('top') ? minimapConfig.margin + 'px' : '',
      right: minimapConfig.position.includes('right') ? minimapConfig.margin + 'px' : '',
      left: minimapConfig.position.includes('left') ? minimapConfig.margin + 'px' : '',
      background: minimapConfig.background,
      border: minimapConfig.border,
      borderRadius: '4px',
      pointerEvents: 'auto',
      cursor: 'pointer'
    });

    minimapNodesG = document.createElementNS(SVG_NS, 'g');
    minimap.appendChild(minimapNodesG);

    minimapViewportRect = document.createElementNS(SVG_NS, 'rect');
    minimapViewportRect.setAttribute('fill', minimapConfig.viewportFill);
    minimapViewportRect.setAttribute('stroke', minimapConfig.viewportStroke);
    minimapViewportRect.setAttribute('stroke-width', '1');
    minimap.appendChild(minimapViewportRect);

    container.appendChild(minimap);
  }

  function destroyMinimap() {
    if (minimapApi) { minimapApi.destroy(); minimapApi = null; }
    if (minimap && minimap.parentNode) minimap.parentNode.removeChild(minimap);
    minimap = null;
    minimapNodesG = null;
    minimapViewportRect = null;
  }

  function renderMinimapNodes() {
    if (!minimap || !currentGraph) return;
    const bounds = getGraphBounds();
    if (!bounds) return;

    while (minimapNodesG.firstChild) minimapNodesG.removeChild(minimapNodesG.firstChild);

    const padding = 4;
    const w = minimapConfig.width - padding * 2;
    const h = minimapConfig.height - padding * 2;
    const scale = Math.min(w / bounds.width, h / bounds.height);
    const offX = padding + (w - bounds.width * scale) / 2 - bounds.x * scale;
    const offY = padding + (h - bounds.height * scale) / 2 - bounds.y * scale;

    currentGraph.nodes.forEach(n => {
      if (n.hidden || n.type === 'label' || typeof n.x !== 'number') return;
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('x', n.x * scale + offX);
      r.setAttribute('y', n.y * scale + offY);
      r.setAttribute('width', Math.max(1, (n.width || 0) * scale));
      r.setAttribute('height', Math.max(1, (n.height || 0) * scale));
      r.setAttribute('fill', minimapConfig.nodeFill);
      r.setAttribute('rx', 1);
      minimapNodesG.appendChild(r);
    });

    minimap._mapTransform = { scale, offX, offY };
    updateMinimapViewport();
  }

  function updateMinimapViewport() {
    if (!minimap || !minimapViewportRect || !minimap._mapTransform) return;
    const { scale, offX, offY } = minimap._mapTransform;
    const v = currentViewport;
    const rect = container.getBoundingClientRect();

    // viewport in graph coords:
    const vx = -v.x / v.zoom;
    const vy = -v.y / v.zoom;
    const vw = rect.width / v.zoom;
    const vh = rect.height / v.zoom;

    minimapViewportRect.setAttribute('x', vx * scale + offX);
    minimapViewportRect.setAttribute('y', vy * scale + offY);
    minimapViewportRect.setAttribute('width', vw * scale);
    minimapViewportRect.setAttribute('height', vh * scale);
  }

  on('viewport.change', updateMinimapViewport);

  function setViewportTransform(v) {
    currentViewport = v;
    viewport.setAttribute(
      'transform',
      `translate(${ v.x }, ${ v.y }) scale(${ v.zoom })`
    );
  }

  function initPanZoom() {
    if (panZoom) {
      panZoom.destroy();
    }

    panZoom = XYPanZoom({
      domNode: svg,
      minZoom: opts.minZoom,
      maxZoom: opts.maxZoom,
      viewport: currentViewport,
      translateExtent: [ [ -Infinity, -Infinity ], [ Infinity, Infinity ] ],
      onPanZoom: (_, v) => {
        currentViewport = v;
        viewport.setAttribute('transform', `translate(${ v.x }, ${ v.y }) scale(${ v.zoom })`);
        emit('viewport.change', { viewport: v });
      },
      onPanZoomStart: NOOP,
      onPanZoomEnd: NOOP,
      onDraggingChange: NOOP
    });

    panZoom.update({
      noWheelClassName: 'nowheel',
      noPanClassName: 'nopan',
      preventScrolling: true,
      panOnScroll: false,
      panOnDrag: true,
      panOnScrollMode: PanOnScrollMode.Free,
      panOnScrollSpeed: 0.5,
      userSelectionActive: false,
      zoomOnPinch: true,
      zoomOnScroll: true,
      zoomOnDoubleClick: true,
      zoomActivationKeyPressed: false,
      lib: 'bpmn-xyflow',
      onTransformChange: NOOP,
      connectionInProgress: false,
      paneClickDistance: 0
    });
  }

  function clear() {
    svgClear(shapeLayer);
    svgClear(connectionLayer);
    svgClear(labelLayer);

    // also clear marker defs from previous render
    const defs = svg.querySelector(':scope > defs');
    if (defs) {
      defs.parentNode.removeChild(defs);
    }
  }

  function renderGraph(graph) {
    clear();

    const { nodes, edges } = graph;

    // shapes (non-label, non-frame first; frames last so they sit beneath)
    const frames = [];
    const labels = [];
    const shapes = [];

    nodes.forEach(node => {
      if (node.type === 'label') {
        labels.push(node);
      } else if (node.isFrame) {
        frames.push(node);
      } else {
        shapes.push(node);
      }
    });

    // BpmnRenderer expects shape coordinates baked into the gfx via parent translation
    function drawShapeNode(node, layer) {
      if (node.hidden) return;

      const g = svgCreate('g', {
        'class': 'bpmn-xyflow-shape',
        'data-element-id': node.id,
        transform: `translate(${ node.x }, ${ node.y })`
      });

      svgAppend(layer, g);

      try {
        renderer.drawShape(g, node);
      } catch (err) {
        console.warn('failed to render shape', node.id, err);
      }
    }

    function drawConnectionEdge(edge) {
      // Delegate to the shared helper so initial render and every
      // subsequent update produce the same SVG (including the
      // rendered connection name label, if any).
      drawConnectionInto(edge);
    }

    function drawLabelNode(node, layer) {
      if (node.hidden) return;

      const g = svgCreate('g', {
        'class': 'bpmn-xyflow-label',
        'data-element-id': node.id,
        transform: `translate(${ node.x }, ${ node.y })`
      });

      svgAppend(layer, g);

      // Labels render as text via TextRenderer
      const text = renderer.textRenderer.createText(node.text || '', {
        box: { width: node.width, height: node.height },
        align: 'center-top',
        padding: 0,
        style: renderer.textRenderer.getExternalStyle()
      });

      svgClasses(text).add('djs-label');
      svgAppend(g, text);
    }

    // draw frames first (lowest z), then shapes, then connections, then labels
    frames.forEach(n => drawShapeNode(n, shapeLayer));
    shapes.forEach(n => drawShapeNode(n, shapeLayer));
    edges.forEach(e => drawConnectionEdge(e, connectionLayer));
    labels.forEach(n => drawLabelNode(n, labelLayer));
  }

  function getGraphBounds() {
    if (!currentGraph) return null;
    const { nodes, edges } = currentGraph;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    nodes.forEach(n => {
      if (n.hidden || typeof n.x !== 'number') return;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + (n.width || 0));
      maxY = Math.max(maxY, n.y + (n.height || 0));
    });

    edges.forEach(e => {
      (e.waypoints || []).forEach(p => {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      });
    });

    if (minX === Infinity) return null;

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  function fitView(padding) {
    const bounds = getGraphBounds();
    if (!bounds) return;

    const rect = container.getBoundingClientRect();
    const v = getViewportForBounds(
      bounds,
      rect.width,
      rect.height,
      opts.minZoom,
      opts.maxZoom,
      padding ?? opts.fitPadding
    );

    if (panZoom) {
      panZoom.setViewport(v, { duration: 0 });
    }
    setViewportTransform(v);
    updateMinimapViewport();
    userTouchedViewport = false;
  }

  function setupMinimap() {
    if (!opts.minimap) return;

    ensureMinimap();

    if (panZoom && !minimapApi) {
      minimapApi = XYMinimap({
        domNode: minimap,
        panZoom,
        getTransform: () => [ currentViewport.x, currentViewport.y, currentViewport.zoom ],
        getViewScale: () => 1
      });
      const rect = container.getBoundingClientRect();
      minimapApi.update({
        translateExtent: [ [ -Infinity, -Infinity ], [ Infinity, Infinity ] ],
        width: rect.width,
        height: rect.height,
        pannable: true,
        zoomable: true,
        zoomStep: 10,
        inversePan: false
      });
    }

    renderMinimapNodes();
  }

  // Public API ////////////

  this.importXML = async function(xml, bpmnDiagramId) {
    const { rootElement: definitions, warnings: parseWarnings } = await parseBpmnXML(xml);

    let bpmnDiagram;
    if (bpmnDiagramId) {
      bpmnDiagram = (definitions.diagrams || []).find(d => d.id === bpmnDiagramId);
      if (!bpmnDiagram) {
        throw new Error(`diagram with id ${ bpmnDiagramId } not found`);
      }
    }

    const graph = buildGraph(definitions, bpmnDiagram);
    currentGraph = graph;
    currentDefinitions = definitions;

    renderGraph(graph);
    initPanZoom();
    setupMinimap();

    if (opts.fitViewOnInit) {
      // wait one frame so container has its size if just mounted
      await new Promise(r => requestAnimationFrame(r));
      fitView();
    }

    userTouchedViewport = false;

    return {
      warnings: [ ...(parseWarnings || []), ...graph.warnings ],
      graph
    };
  };

  /**
   * Switch the rendered diagram without re-parsing XML — keeps the
   * current moddle tree intact (so commands holding references to its
   * objects stay valid at outer levels). Used by drill-in.
   */
  this.switchDiagram = async function(bpmnDiagramId) {
    if (!currentDefinitions) throw new Error('no diagram loaded');
    const diagram = (currentDefinitions.diagrams || []).find(d => d.id === bpmnDiagramId);
    if (!diagram) throw new Error(`diagram with id ${ bpmnDiagramId } not found`);
    const graph = buildGraph(currentDefinitions, diagram);
    currentGraph = graph;
    renderGraph(graph);
    initPanZoom();
    setupMinimap();
    await new Promise(r => requestAnimationFrame(r));
    fitView();
    userTouchedViewport = false;
    return { graph, warnings: graph.warnings };
  };

  this.fitView = fitView;

  this.getViewport = function() {
    return panZoom ? panZoom.getViewport() : { ...currentViewport };
  };

  this.setViewport = function(v, transformOptions) {
    if (panZoom) {
      panZoom.setViewport(v, transformOptions);
    }
    setViewportTransform(v);
  };

  this.getGraph = function() {
    return currentGraph;
  };

  this.getDefinitions = function() {
    return currentDefinitions;
  };

  this.getContainer = function() {
    return container;
  };

  this.getSvg = function() {
    return svg;
  };

  this.on = on;
  this.off = off;

  this.select = function(idOrIds) {
    const ids = Array.isArray(idOrIds) ? idOrIds : [ idOrIds ];
    setSelection(ids);
  };

  this.deselect = function(idOrIds) {
    if (idOrIds === undefined) {
      setSelection([]);
      return;
    }
    const remove = new Set(Array.isArray(idOrIds) ? idOrIds : [ idOrIds ]);
    setSelection([ ...selection ].filter(id => !remove.has(id)));
  };

  this.getSelection = function() {
    return [ ...selection ];
  };

  this.clearSelection = function() {
    setSelection([]);
  };

  this.getElement = getElement;

  // Internals for the modeler / extensions /////////////
  this._internals = {
    get svg() { return svg; },
    get viewport() { return viewport; },
    get shapeLayer() { return shapeLayer; },
    get connectionLayer() { return connectionLayer; },
    get labelLayer() { return labelLayer; },
    get renderer() { return renderer; },
    get panZoom() { return panZoom; },
    get currentViewport() { return currentViewport; },
    elementGfx,
    findElementId,
    setSelection,
    emit,
    refreshMinimap() {
      // re-render the minimap node rects + viewport indicator after
      // an edit (add / move / delete / resize).
      if (typeof renderMinimapNodes === 'function') renderMinimapNodes();
    },
    /**
     * Convert pointer (page) coords to graph coords.
     */
    toGraph(clientX, clientY) {
      const rect = svg.getBoundingClientRect();
      const v = currentViewport;
      return {
        x: (clientX - rect.left - v.x) / v.zoom,
        y: (clientY - rect.top - v.y) / v.zoom
      };
    },
    redrawShape(node) {
      const old = elementGfx(node.id);
      if (old) old.parentNode.removeChild(old);
      if (node.hidden) return;
      const g = svgCreate('g', {
        'class': 'bpmn-xyflow-shape',
        'data-element-id': node.id,
        transform: `translate(${ node.x }, ${ node.y })`
      });
      svgAppend(shapeLayer, g);
      try { renderer.drawShape(g, node); } catch (e) { console.warn('redrawShape', node.id, e); }
      return g;
    },
    redrawConnection(edge) {
      return drawConnectionInto(edge);
    },
    removeElementGfx(id) {
      const g = elementGfx(id);
      if (g) g.parentNode.removeChild(g);
    },
    refreshSelection() {
      // re-apply current selection's CSS class (after redraw)
      [ ...selection ].forEach(id => applySelectionClass(id, true));
    }
  };

  this.setMinimap = function(value) {
    opts.minimap = value;
    if (!value) {
      destroyMinimap();
    } else if (currentGraph) {
      destroyMinimap();
      setupMinimap();
    }
  };

  this.destroy = function() {
    if (panZoom) {
      panZoom.destroy();
      panZoom = null;
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    svg.removeEventListener('keydown', handleKey);
    destroyMinimap();
    clear();
    if (svg.parentNode === container) {
      container.removeChild(svg);
    }
    listeners.clear();
    currentGraph = null;
    currentDefinitions = null;
  };
}
