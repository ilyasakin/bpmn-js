import {
  XYPanZoom,
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

const DEFAULT_OPTIONS = {
  minZoom: 0.2,
  maxZoom: 4,
  fitPadding: 20,
  fitViewOnInit: true
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

    function drawConnectionEdge(edge, layer) {
      if (edge.hidden) return;

      const g = svgCreate('g', {
        'class': 'bpmn-xyflow-connection',
        'data-element-id': edge.id
      });

      svgAppend(layer, g);

      try {
        renderer.drawConnection(g, edge);
      } catch (err) {
        console.warn('failed to render connection', edge.id, err);
      }
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

    if (opts.fitViewOnInit) {
      // wait one frame so container has its size if just mounted
      await new Promise(r => requestAnimationFrame(r));
      fitView();
    }

    return {
      warnings: [ ...(parseWarnings || []), ...graph.warnings ],
      graph
    };
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

  this.destroy = function() {
    if (panZoom) {
      panZoom.destroy();
      panZoom = null;
    }
    clear();
    if (svg.parentNode === container) {
      container.removeChild(svg);
    }
    currentGraph = null;
    currentDefinitions = null;
  };
}
