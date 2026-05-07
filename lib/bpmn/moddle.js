// Lightweight, dependency-free BPMN 2.0 moddle replacement.
// Provides the subset of bpmn-moddle API used by this fork:
//
//   const moddle = BpmnModdle();
//   moddle.fromXML(xml)        → { rootElement, warnings, references }
//   moddle.toXML(defs, opts)   → { xml }
//   moddle.create(type, attrs) → typed business object
//
// Objects expose:
//   $type, $parent, $instanceOf(type), get(name), set(name, value)
//
// The schema below is intentionally minimal: it covers exactly the BPMN
// elements / attributes / references the rest of the app reads or writes.

const NS = {
  bpmn:   'http://www.omg.org/spec/BPMN/20100524/MODEL',
  bpmndi: 'http://www.omg.org/spec/BPMN/20100524/DI',
  di:     'http://www.omg.org/spec/DD/20100524/DI',
  dc:     'http://www.omg.org/spec/DD/20100524/DC',
  xsi:    'http://www.w3.org/2001/XMLSchema-instance'
};

const NS_TO_PREFIX = Object.fromEntries(
  Object.entries(NS).map(([ p, u ]) => [ u, p ])
);

// type → parent type. null = root of hierarchy.
const PARENT = {
  'bpmn:BaseElement': null,
  'bpmn:Definitions': 'bpmn:BaseElement',
  'bpmn:RootElement': 'bpmn:BaseElement',
  'bpmn:CallableElement': 'bpmn:RootElement',
  'bpmn:Process': 'bpmn:CallableElement',
  'bpmn:Collaboration': 'bpmn:RootElement',
  'bpmn:DataStore': 'bpmn:RootElement',
  'bpmn:Message': 'bpmn:RootElement',
  'bpmn:Signal': 'bpmn:RootElement',
  'bpmn:Error': 'bpmn:RootElement',
  'bpmn:Escalation': 'bpmn:RootElement',
  'bpmn:Category': 'bpmn:RootElement',

  'bpmn:FlowElementsContainer': 'bpmn:BaseElement',
  'bpmn:Participant': 'bpmn:BaseElement',
  'bpmn:LaneSet': 'bpmn:BaseElement',
  'bpmn:Lane': 'bpmn:BaseElement',
  'bpmn:MessageFlow': 'bpmn:BaseElement',
  'bpmn:DataInput': 'bpmn:ItemAwareElement',
  'bpmn:DataOutput': 'bpmn:ItemAwareElement',
  'bpmn:ItemAwareElement': 'bpmn:BaseElement',
  'bpmn:IoSpecification': 'bpmn:BaseElement',

  'bpmn:FlowElement': 'bpmn:BaseElement',
  'bpmn:FlowNode': 'bpmn:FlowElement',
  'bpmn:Activity': 'bpmn:FlowNode',
  'bpmn:Task': 'bpmn:Activity',
  'bpmn:UserTask': 'bpmn:Task',
  'bpmn:ServiceTask': 'bpmn:Task',
  'bpmn:BusinessRuleTask': 'bpmn:Task',
  'bpmn:ScriptTask': 'bpmn:Task',
  'bpmn:ManualTask': 'bpmn:Task',
  'bpmn:SendTask': 'bpmn:Task',
  'bpmn:ReceiveTask': 'bpmn:Task',
  'bpmn:SubProcess': 'bpmn:Activity',
  'bpmn:AdHocSubProcess': 'bpmn:SubProcess',
  'bpmn:Transaction': 'bpmn:SubProcess',
  'bpmn:CallActivity': 'bpmn:Activity',

  'bpmn:Event': 'bpmn:FlowNode',
  'bpmn:CatchEvent': 'bpmn:Event',
  'bpmn:StartEvent': 'bpmn:CatchEvent',
  'bpmn:BoundaryEvent': 'bpmn:CatchEvent',
  'bpmn:IntermediateCatchEvent': 'bpmn:CatchEvent',
  'bpmn:ThrowEvent': 'bpmn:Event',
  'bpmn:EndEvent': 'bpmn:ThrowEvent',
  'bpmn:IntermediateThrowEvent': 'bpmn:ThrowEvent',
  'bpmn:ImplicitThrowEvent': 'bpmn:ThrowEvent',

  'bpmn:Gateway': 'bpmn:FlowNode',
  'bpmn:ExclusiveGateway': 'bpmn:Gateway',
  'bpmn:InclusiveGateway': 'bpmn:Gateway',
  'bpmn:ParallelGateway': 'bpmn:Gateway',
  'bpmn:EventBasedGateway': 'bpmn:Gateway',
  'bpmn:ComplexGateway': 'bpmn:Gateway',

  'bpmn:SequenceFlow': 'bpmn:FlowElement',
  'bpmn:DataObject': 'bpmn:FlowElement',
  'bpmn:DataObjectReference': 'bpmn:FlowElement',
  'bpmn:DataStoreReference': 'bpmn:FlowElement',

  'bpmn:Artifact': 'bpmn:BaseElement',
  'bpmn:Group': 'bpmn:Artifact',
  'bpmn:TextAnnotation': 'bpmn:Artifact',
  'bpmn:Association': 'bpmn:Artifact',

  'bpmn:DataAssociation': 'bpmn:BaseElement',
  'bpmn:DataInputAssociation': 'bpmn:DataAssociation',
  'bpmn:DataOutputAssociation': 'bpmn:DataAssociation',

  'bpmn:LoopCharacteristics': 'bpmn:BaseElement',
  'bpmn:StandardLoopCharacteristics': 'bpmn:LoopCharacteristics',
  'bpmn:MultiInstanceLoopCharacteristics': 'bpmn:LoopCharacteristics',

  'bpmn:EventDefinition': 'bpmn:BaseElement',
  'bpmn:MessageEventDefinition': 'bpmn:EventDefinition',
  'bpmn:TimerEventDefinition': 'bpmn:EventDefinition',
  'bpmn:ErrorEventDefinition': 'bpmn:EventDefinition',
  'bpmn:EscalationEventDefinition': 'bpmn:EventDefinition',
  'bpmn:CancelEventDefinition': 'bpmn:EventDefinition',
  'bpmn:CompensateEventDefinition': 'bpmn:EventDefinition',
  'bpmn:SignalEventDefinition': 'bpmn:EventDefinition',
  'bpmn:LinkEventDefinition': 'bpmn:EventDefinition',
  'bpmn:TerminateEventDefinition': 'bpmn:EventDefinition',
  'bpmn:ConditionalEventDefinition': 'bpmn:EventDefinition',

  'bpmn:Expression': 'bpmn:BaseElement',
  'bpmn:FormalExpression': 'bpmn:Expression',
  'bpmn:Documentation': 'bpmn:BaseElement',

  'bpmndi:BPMNDiagram': null,
  'bpmndi:BPMNPlane': null,
  'bpmndi:BPMNShape': 'bpmndi:DiagramElement',
  'bpmndi:BPMNEdge': 'bpmndi:DiagramElement',
  'bpmndi:BPMNLabel': null,
  'bpmndi:DiagramElement': null,
  'dc:Bounds': null,
  'dc:Point': null
};

// types that "are also" something (multiple-inheritance / mixins)
const ALSO = {
  'bpmn:Process': [ 'bpmn:FlowElementsContainer' ],
  'bpmn:SubProcess': [ 'bpmn:FlowElementsContainer' ],
  'bpmn:AdHocSubProcess': [ 'bpmn:FlowElementsContainer' ],
  'bpmn:Transaction': [ 'bpmn:FlowElementsContainer' ]
};

function isA(type, target) {
  if (!type) return false;
  if (type === target) return true;
  const p = PARENT[type];
  if (p && isA(p, target)) return true;
  for (const a of ALSO[type] || []) {
    if (isA(a, target)) return true;
  }
  return false;
}

// Map an XML element's namespace URI to a canonical prefix we use
// internally. bpmn-js fixtures in the wild use any of: bpmn:, bpmn2:,
// no prefix (default namespace), and omgdc/omgdi for DC/DI.
function nsPrefix(uri) {
  if (NS_TO_PREFIX[uri]) return NS_TO_PREFIX[uri];
  // unknown / xmlns="" — assume bpmn root
  return 'bpmn';
}

// XML tag → moddle type, when the simple "{prefix}:{Capitalized localName}"
// rule doesn't match (e.g. <di:waypoint> elements are dc:Point typed).
const TAG_TO_TYPE = {
  'di:waypoint': 'dc:Point'
};

// Map XML element to canonical type ("bpmn:Task", "dc:Bounds", …).
function tagToType(node) {
  const prefix = nsPrefix(node.namespaceURI);
  const local = node.localName;
  const exact = TAG_TO_TYPE[prefix + ':' + local];
  if (exact) return exact;
  if (prefix === 'bpmndi' || prefix === 'dc' || prefix === 'di') {
    return prefix + ':' + (local[0].toUpperCase() + local.slice(1));
  }
  return 'bpmn:' + (local[0].toUpperCase() + local.slice(1));
}

// type → (parentType → tag) override. BPMNEdge serializes its dc:Point
// list as <di:waypoint>, not <dc:point>.
const TYPE_TO_TAG = {
  'dc:Point': { 'bpmndi:BPMNEdge': 'di:waypoint' }
};

function typeToTag(type, parentType) {
  const ov = TYPE_TO_TAG[type];
  if (ov && parentType && ov[parentType]) return ov[parentType];
  const [ prefix, name ] = type.split(':');
  if (prefix === 'bpmndi' || prefix === 'dc' || prefix === 'di') {
    return prefix + ':' + name;
  }
  return prefix + ':' + (name[0].toLowerCase() + name.slice(1));
}

// Build a moddle-shaped object. Non-enumerable meta methods so JSON.stringify
// stays clean if anything tries it.
function createObject(type, attrs = {}) {
  const obj = {};
  for (const [ k, v ] of Object.entries(attrs)) {
    if (v !== undefined) obj[k] = v;
  }
  Object.defineProperty(obj, '$type', { value: type, enumerable: false, writable: true });
  Object.defineProperty(obj, '$parent', { value: null, enumerable: false, writable: true });
  Object.defineProperty(obj, '$instanceOf', {
    value: function(t) { return isA(this.$type, t); },
    enumerable: false, writable: true
  });
  Object.defineProperty(obj, 'get', {
    value: function(name) { return this[name]; },
    enumerable: false, writable: true
  });
  Object.defineProperty(obj, 'set', {
    value: function(name, value) { this[name] = value; return this; },
    enumerable: false, writable: true
  });
  return obj;
}

// ─────────────────────────────────────────────────────────────────────────
// SCHEMA: where each child type goes inside its parent + which attrs are refs

// Property bag rules: ordered by specificity. Each rule says: when a child
// of `childType` appears inside a parent of `parentType`, it goes into the
// parent's `prop` (list when isMany, otherwise single).
const BAG_RULES = [
  // BPMNDI
  { parent: 'bpmndi:BPMNDiagram', child: 'bpmndi:BPMNPlane',  prop: 'plane',           isMany: false },
  { parent: 'bpmndi:BPMNPlane',   child: 'bpmndi:DiagramElement', prop: 'planeElement', isMany: true  },
  { parent: 'bpmndi:BPMNShape',   child: 'dc:Bounds',         prop: 'bounds',          isMany: false },
  { parent: 'bpmndi:BPMNShape',   child: 'bpmndi:BPMNLabel',  prop: 'label',           isMany: false },
  { parent: 'bpmndi:BPMNEdge',    child: 'dc:Point',          prop: 'waypoint',        isMany: true  },
  { parent: 'bpmndi:BPMNEdge',    child: 'bpmndi:BPMNLabel',  prop: 'label',           isMany: false },
  { parent: 'bpmndi:BPMNLabel',   child: 'dc:Bounds',         prop: 'bounds',          isMany: false },

  // Definitions
  { parent: 'bpmn:Definitions', child: 'bpmn:RootElement',   prop: 'rootElements', isMany: true },
  { parent: 'bpmn:Definitions', child: 'bpmndi:BPMNDiagram', prop: 'diagrams',     isMany: true },

  // Process / SubProcess (FlowElementsContainer)
  { parent: 'bpmn:FlowElementsContainer', child: 'bpmn:FlowElement',    prop: 'flowElements', isMany: true },
  { parent: 'bpmn:FlowElementsContainer', child: 'bpmn:LaneSet',        prop: 'laneSets',     isMany: true },
  { parent: 'bpmn:FlowElementsContainer', child: 'bpmn:Artifact',       prop: 'artifacts',    isMany: true },
  { parent: 'bpmn:FlowElementsContainer', child: 'bpmn:IoSpecification', prop: 'ioSpecification', isMany: false },

  // Collaboration
  { parent: 'bpmn:Collaboration', child: 'bpmn:Participant',  prop: 'participants',  isMany: true },
  { parent: 'bpmn:Collaboration', child: 'bpmn:MessageFlow',  prop: 'messageFlows',  isMany: true },
  { parent: 'bpmn:Collaboration', child: 'bpmn:Artifact',     prop: 'artifacts',     isMany: true },

  // LaneSet / Lane
  { parent: 'bpmn:LaneSet', child: 'bpmn:Lane',    prop: 'lanes',         isMany: true },
  { parent: 'bpmn:Lane',    child: 'bpmn:LaneSet', prop: 'childLaneSet',  isMany: false },

  // FlowNode bits
  { parent: 'bpmn:Activity', child: 'bpmn:LoopCharacteristics',     prop: 'loopCharacteristics',    isMany: false },
  { parent: 'bpmn:Activity', child: 'bpmn:DataInputAssociation',    prop: 'dataInputAssociations',  isMany: true  },
  { parent: 'bpmn:Activity', child: 'bpmn:DataOutputAssociation',   prop: 'dataOutputAssociations', isMany: true  },
  { parent: 'bpmn:Activity', child: 'bpmn:IoSpecification',         prop: 'ioSpecification',        isMany: false },
  { parent: 'bpmn:Event',    child: 'bpmn:EventDefinition',         prop: 'eventDefinitions',       isMany: true  },
  { parent: 'bpmn:Event',    child: 'bpmn:DataInputAssociation',    prop: 'dataInputAssociations',  isMany: true  },
  { parent: 'bpmn:Event',    child: 'bpmn:DataOutputAssociation',   prop: 'dataOutputAssociations', isMany: true  },

  // IoSpecification
  { parent: 'bpmn:IoSpecification', child: 'bpmn:DataInput',  prop: 'dataInputs',  isMany: true },
  { parent: 'bpmn:IoSpecification', child: 'bpmn:DataOutput', prop: 'dataOutputs', isMany: true }
];

function findBag(parentType, childType) {
  for (const rule of BAG_RULES) {
    if (isA(parentType, rule.parent) && isA(childType, rule.child)) {
      return rule;
    }
  }
  return null;
}

// XML attribute name → "is reference" rules. When parsing, store as string
// id and resolve later. When serializing, write the referenced object's id.
const REF_ATTRS = new Set([
  'bpmnElement', 'attachedToRef', 'sourceRef', 'targetRef',
  'processRef', 'categoryValueRef', 'default'
]);

// XML body-text elements: tag → { prop, isMany, ref? }
// e.g. <bpmn:flowNodeRef>X</bpmn:flowNodeRef> as a child of Lane stores
// "X" in lane.flowNodeRef (list, later resolved to objects).
const BODY_REF_ELEMENTS = {
  'bpmn:flowNodeRef': { prop: 'flowNodeRef', isMany: true,  ref: true, parent: 'bpmn:Lane' },
  'bpmn:incoming':    { prop: 'incoming',    isMany: true,  ref: true, parent: 'bpmn:FlowNode' },
  'bpmn:outgoing':    { prop: 'outgoing',    isMany: true,  ref: true, parent: 'bpmn:FlowNode' },
  'bpmn:sourceRef':   { prop: 'sourceRef',   isMany: true,  ref: true, parent: 'bpmn:DataAssociation' },
  'bpmn:targetRef':   { prop: 'targetRef',   isMany: false, ref: true, parent: 'bpmn:DataAssociation' }
};

// Numeric XML attributes (parsed to floats, serialized without quotes-wrap)
const NUMERIC_ATTRS = new Set([ 'x', 'y', 'width', 'height' ]);

// Boolean XML attributes
const BOOLEAN_ATTRS = new Set([
  'isExecutable', 'isExpanded', 'isHorizontal', 'cancelActivity',
  'isInterrupting', 'isCollection', 'triggeredByEvent', 'isForCompensation',
  'parallelMultiple'
]);

function coerceAttr(name, value) {
  if (NUMERIC_ATTRS.has(name)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (BOOLEAN_ATTRS.has(name)) {
    return value === 'true';
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────
// PARSER

function getParser() {
  if (typeof DOMParser !== 'undefined') return new DOMParser();
  throw new Error('DOMParser not available; call moddle.fromXML() in a browser context');
}

export function parseXML(xml) {
  const doc = getParser().parseFromString(xml, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) {
    return Promise.reject(new Error('XML parse error: ' + err.textContent));
  }

  const root = doc.documentElement;
  const warnings = [];
  const idMap = new Map();
  const pendingRefs = []; // { obj, key, idValue, isMany }

  function nodeType(node) {
    return tagToType(node);
  }

  function parseNode(node) {
    const type = nodeType(node);
    const obj = createObject(type, {});

    // attributes
    for (const attr of Array.from(node.attributes)) {
      // skip namespace declarations
      if (attr.name === 'xmlns' || attr.name.startsWith('xmlns:')) continue;
      if (attr.prefix === 'xsi' || attr.name === 'xsi:type') continue;

      const localName = attr.localName;
      if (REF_ATTRS.has(localName)) {
        pendingRefs.push({ obj, key: localName, idValue: attr.value, isMany: false });
      } else {
        obj[localName] = coerceAttr(localName, attr.value);
      }
    }

    if (obj.id) idMap.set(obj.id, obj);

    // children
    let textBody = '';
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3 /* text */ || child.nodeType === 4 /* CDATA */) {
        textBody += child.nodeValue;
        continue;
      }
      if (child.nodeType !== 1 /* element */) continue;

      // canonical "{prefix}:{localName}" for body-ref + child tag lookup
      const childPrefix = nsPrefix(child.namespaceURI);
      const childTagFull = childPrefix + ':' + child.localName;

      // body-text reference elements (incoming/outgoing/flowNodeRef/etc)
      const bodyRef = BODY_REF_ELEMENTS[childTagFull];
      if (bodyRef) {
        const idValue = child.textContent.trim();
        pendingRefs.push({ obj, key: bodyRef.prop, idValue, isMany: bodyRef.isMany });
        continue;
      }

      // documentation / extensionElements / ioSpecification.dataInputRefs etc.
      // capture but don't crash on unknowns.
      const childObj = parseNode(child);
      childObj.$parent = obj;

      const childType = childObj.$type;
      const bag = findBag(type, childType);
      if (!bag) {
        // Try to fit common patterns: documentation as list, conditionExpression as single.
        const localName = child.localName;
        if (localName === 'documentation') {
          obj.documentation = obj.documentation || [];
          obj.documentation.push(childObj);
        } else if (localName === 'conditionExpression') {
          obj.conditionExpression = childObj;
        } else if (localName === 'completionCondition') {
          obj.completionCondition = childObj;
        } else if (localName === 'extensionElements') {
          obj.extensionElements = childObj;
        } else if (localName === 'text' && obj.$type === 'bpmn:TextAnnotation') {
          obj.text = child.textContent;
        } else {
          // last resort: stash so round-trip preserves it
          obj.__extras = obj.__extras || [];
          obj.__extras.push(childObj);
          warnings.push({ message: `unmapped child <${ childTagFull }> in <${ typeToTag(type) }>`, context: { element: obj } });
        }
        continue;
      }

      if (bag.isMany) {
        obj[bag.prop] = obj[bag.prop] || [];
        obj[bag.prop].push(childObj);
      } else {
        obj[bag.prop] = childObj;
      }
    }

    if (textBody.trim() && type !== 'bpmn:Definitions') {
      obj.body = textBody.trim();
    }

    return obj;
  }

  const rootObj = parseNode(root);

  // resolve references
  for (const ref of pendingRefs) {
    const target = idMap.get(ref.idValue);
    if (!target) {
      warnings.push({ message: `unresolved reference: ${ ref.key } → ${ ref.idValue }`, context: { element: ref.obj } });
      continue;
    }
    if (ref.isMany) {
      ref.obj[ref.key] = ref.obj[ref.key] || [];
      ref.obj[ref.key].push(target);
    } else {
      ref.obj[ref.key] = target;
    }
  }

  return Promise.resolve({ rootElement: rootObj, warnings, references: pendingRefs, elementsById: idMap });
}

// ─────────────────────────────────────────────────────────────────────────
// SERIALIZER

const PROP_ORDER = {
  // Definitions: rootElements come before diagrams
  'bpmn:Definitions': [ 'rootElements', 'diagrams' ],
  // Process: laneSets, flowElements, artifacts (BPMN canonical order)
  'bpmn:Process': [ 'laneSets', 'ioSpecification', 'flowElements', 'artifacts' ],
  'bpmn:SubProcess': [ 'laneSets', 'ioSpecification', 'flowElements', 'artifacts' ],
  'bpmn:AdHocSubProcess': [ 'laneSets', 'ioSpecification', 'flowElements', 'artifacts' ],
  'bpmn:Transaction': [ 'laneSets', 'ioSpecification', 'flowElements', 'artifacts' ],
  'bpmn:Collaboration': [ 'participants', 'messageFlows', 'artifacts' ],
  'bpmn:LaneSet': [ 'lanes' ],
  'bpmn:Lane': [ 'flowNodeRef', 'childLaneSet' ],
  'bpmn:Activity': [ 'ioSpecification', 'dataInputAssociations', 'dataOutputAssociations', 'loopCharacteristics' ],
  'bpmn:Event': [ 'eventDefinitions', 'dataInputAssociations', 'dataOutputAssociations' ],
  'bpmn:IoSpecification': [ 'dataInputs', 'dataOutputs' ],

  'bpmndi:BPMNDiagram': [ 'plane' ],
  'bpmndi:BPMNPlane': [ 'planeElement' ],
  'bpmndi:BPMNShape': [ 'bounds', 'label' ],
  'bpmndi:BPMNEdge': [ 'waypoint', 'label' ],
  'bpmndi:BPMNLabel': [ 'bounds' ]
};

function getPropOrder(type) {
  // walk ancestor chain merging orders
  const order = [];
  let t = type;
  while (t) {
    if (PROP_ORDER[t]) {
      for (const p of PROP_ORDER[t]) {
        if (!order.includes(p)) order.push(p);
      }
    }
    t = PARENT[t];
  }
  return order;
}

const ATTR_ORDER = [
  // common
  'id', 'name', 'isHorizontal', 'isExpanded', 'isExecutable',
  // refs & flow attributes
  'sourceRef', 'targetRef', 'attachedToRef', 'cancelActivity', 'processRef',
  'categoryValueRef', 'default', 'associationDirection',
  'triggeredByEvent', 'isCollection', 'isForCompensation',
  // dc / bpmndi
  'bpmnElement', 'x', 'y', 'width', 'height'
];

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attrValue(name, value) {
  if (REF_ATTRS.has(name) && value && typeof value === 'object') {
    return value.id;
  }
  if (BOOLEAN_ATTRS.has(name)) return value ? 'true' : 'false';
  return String(value);
}

function isPropertyAttribute(key, value) {
  if (typeof value === 'object' && value !== null) {
    // refs are stored as object pointers; treat as attribute if name says so
    return REF_ATTRS.has(key);
  }
  // primitives are attributes (excluding the reserved book-keeping ones)
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function serializeElement(obj, depth, parentType) {
  const indent = '  '.repeat(depth);
  const tag = typeToTag(obj.$type, parentType);

  // attributes
  const attrEntries = [];
  for (const key of Object.keys(obj)) {
    if (key === '__extras' || key === 'body') continue;
    const v = obj[key];
    if (!isPropertyAttribute(key, v)) continue;
    attrEntries.push([ key, attrValue(key, v) ]);
  }
  attrEntries.sort((a, b) => {
    const ai = ATTR_ORDER.indexOf(a[0]);
    const bi = ATTR_ORDER.indexOf(b[0]);
    if (ai === -1 && bi === -1) return a[0].localeCompare(b[0]);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  let attrStr = attrEntries.map(([ k, v ]) => `${ k }="${ escapeXml(v) }"`).join(' ');

  if (depth === 0) {
    const xmlns = [
      `xmlns:bpmn="${ NS.bpmn }"`,
      `xmlns:bpmndi="${ NS.bpmndi }"`,
      `xmlns:di="${ NS.di }"`,
      `xmlns:dc="${ NS.dc }"`,
      `xmlns:xsi="${ NS.xsi }"`
    ].join(' ');
    attrStr = attrStr ? xmlns + ' ' + attrStr : xmlns;
  }

  // child elements
  const order = getPropOrder(obj.$type);
  const seen = new Set([ '__extras', 'body' ]);
  const childChunks = [];

  function emit(prop) {
    if (seen.has(prop)) return;
    seen.add(prop);
    const v = obj[prop];
    if (v == null) return;

    // body-ref props (string or object → id)
    const bodyRef = Object.values(BODY_REF_ELEMENTS).find(b => b.prop === prop);
    if (bodyRef) {
      const arr = bodyRef.isMany ? v : [ v ];
      const tagName = Object.keys(BODY_REF_ELEMENTS).find(t => BODY_REF_ELEMENTS[t].prop === prop);
      for (const ref of arr) {
        const id = typeof ref === 'object' ? ref.id : ref;
        childChunks.push(`${ '  '.repeat(depth + 1) }<${ tagName }>${ escapeXml(id) }</${ tagName }>`);
      }
      return;
    }

    if (Array.isArray(v)) {
      for (const child of v) {
        if (child && child.$type) childChunks.push(serializeElement(child, depth + 1, obj.$type));
      }
    } else if (typeof v === 'object' && v.$type) {
      childChunks.push(serializeElement(v, depth + 1, obj.$type));
    }
  }

  for (const prop of order) emit(prop);

  // remaining object/array props not covered by order
  for (const key of Object.keys(obj)) {
    if (seen.has(key)) continue;
    const v = obj[key];
    if (v == null || isPropertyAttribute(key, v)) continue;
    if (Array.isArray(v) || (typeof v === 'object' && v.$type)) {
      emit(key);
    }
  }

  // text bodies (e.g. TextAnnotation.text)
  if (obj.$type === 'bpmn:TextAnnotation' && obj.text) {
    childChunks.push(`${ '  '.repeat(depth + 1) }<bpmn:text>${ escapeXml(obj.text) }</bpmn:text>`);
  }

  if (childChunks.length === 0 && !obj.body) {
    return `${ indent }<${ tag }${ attrStr ? ' ' + attrStr : '' } />`;
  }

  let inner = childChunks.join('\n');
  if (obj.body) inner = (inner ? inner + '\n' : '') + escapeXml(obj.body);

  return `${ indent }<${ tag }${ attrStr ? ' ' + attrStr : '' }>\n${ inner }\n${ indent }</${ tag }>`;
}

export function serializeXML(rootElement, options = {}) {
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + serializeElement(rootElement, 0);
  return options.format === false ? xml : xml;
}

// ─────────────────────────────────────────────────────────────────────────
// Public API: BpmnModdle()

export function BpmnModdle() {
  return {
    fromXML(xml) {
      return parseXML(xml);
    },
    toXML(rootElement, options = {}) {
      return Promise.resolve({ xml: serializeXML(rootElement, options) });
    },
    create(type, attrs = {}) {
      return createObject(type, attrs);
    }
  };
}

// also exported for direct use
export { createObject, isA, NS };
