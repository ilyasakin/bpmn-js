# bpmn-js — BPMN 2.0 for the web (xyflow-based)

View and edit BPMN 2.0 diagrams in the browser. This implementation
is built on [@xyflow/system](https://github.com/xyflow/xyflow) for
pan/zoom and the original
[BpmnRenderer](./lib/draw/BpmnRenderer.js) /
[TextRenderer](./lib/draw/TextRenderer.js) /
[PathMap](./lib/draw/PathMap.js) for the BPMN shape SVG paths. The
older diagram-js-based viewer/modeler stack has been replaced.

## Quick start

```js
import { Viewer, Modeler } from 'bpmn-js';

const viewer = new Viewer({ container: document.getElementById('app') });
await viewer.importXML(xml);
viewer.fitView();
```

For full editing:

```js
const modeler = new Modeler({
  container: document.getElementById('app'),
  minimap: true
});
await modeler.importXML(xml);

// Save back out
const xml = await modeler.getXML();
```

## Framework wrappers

```js
import { BpmnViewer } from 'bpmn-js/lib/react';   // React 18+
import { BpmnViewer } from 'bpmn-js/lib/vue';     // Vue 3
import BpmnViewer from 'bpmn-js/lib/svelte/BpmnViewer.svelte';  // Svelte 4
```

Each wrapper takes the same `xml` prop, forwards every viewer event
(`onElementClick` / `onSelectionChange` / `onViewportChange` / etc.)
and exposes the imperative API (`fitView`, `select`, `setViewport`,
…) via the framework's standard ref / `bind:this` mechanism.

## Modeler features

- Move shapes (drag); edges follow with bend preservation
- Resize shapes (8 handles) — descendants of a Lane / SubProcess
  follow; attached BoundaryEvents slide along the perimeter
- Connect shapes — context-pad button, hover-edge handle, or
  Shift+drag — with BPMN-aware type inference (SequenceFlow /
  MessageFlow / Association / DataAssociation)
- Reconnect by dragging an edge endpoint to a different shape
- Inline label editing (seamless: editor matches renderer font and
  position, follows zoom while open)
- Undo / redo (`Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`); compound steps —
  one user gesture = one undo
- Copy / paste (`Cmd+C` / `Cmd+V` / `Cmd+D` to duplicate)
- Modeling rules + connection-type inference
- BoundaryEvent attach / detach on drop
- SubProcess drill-in / collapse, with a per-level command stack
- Snap to siblings + 5px grid + alignment guides; `Shift` constrains
  to dominant axis
- BPMN XML round-trip via `bpmn-moddle`'s writer

## Demo

```sh
npm install
npm start
```

Then open the routes the dev server prints:

| Route       | What |
|-------------|------|
| `/`         | vanilla viewer demo (read-only) |
| `/modeler`  | full modeler with palette, minimap, export |
| `/react`    | React-wrapped demo |
| `/vue`      | Vue-wrapped demo |
| `/svelte`   | Svelte-wrapped demo |

## Tests

```sh
npm test                    # all puppeteer-driven smoke suites
npm run test:smoke          # modeler (~56 cases)
npm run test:react          # React wrapper
npm run test:multi          # React, Vue, and Svelte wrappers
```

## Repo layout

```
lib/
├── Viewer.js         read-only viewer
├── Modeler.js        full editor
├── Importer.js       BPMN XML → graph
├── Renderer.js       wraps the bpmn-js BpmnRenderer
├── modeling/         CommandStack + Rules
├── react/  vue/  svelte/   framework wrappers
├── demo/             dev server + smoke tests
├── draw/             reused: BpmnRenderer, TextRenderer, PathMap
├── import/           reused: BpmnTreeWalker
├── util/             reused: ModelUtil, LabelUtil, DiUtil, …
└── model/            BPMN type definitions
```

## License

See [LICENSE](./LICENSE).
