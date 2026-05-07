/**
 * Lightweight BPMN modeling rules.
 *
 * Returns the BPMN connection type that is valid for a given
 * (source, target) shape pair, or `null` if the connection is rejected.
 * The result is what `Modeler.connect(...)` should construct, so this
 * module is also the connection-type inference oracle.
 *
 * Rules cover the common 80%; we deliberately stay simpler than
 * bpmn-js's full bpmn-rules module — enough to keep new diagrams
 * BPMN-valid without false-positives blocking power users.
 */

function instanceOf(bo, type) {
  return bo && typeof bo.$instanceOf === 'function' && bo.$instanceOf(type);
}

function isAny(bo, types) {
  return types.some(t => instanceOf(bo, t));
}

function findRootContainer(node) {
  let cur = node;
  while (cur && cur.businessObject) {
    const bo = cur.businessObject;
    if (instanceOf(bo, 'bpmn:Process') || instanceOf(bo, 'bpmn:Collaboration')) {
      return bo;
    }
    if (instanceOf(bo, 'bpmn:Participant')) {
      return bo.processRef || bo.$parent;
    }
    cur = cur.parent;
  }
  return null;
}

function getRootProcess(bo) {
  let cur = bo;
  while (cur) {
    if (instanceOf(cur, 'bpmn:Process')) return cur;
    cur = cur.$parent;
  }
  return null;
}

function isSameProcess(a, b) {
  const ra = getRootProcess(a.businessObject) || findRootContainer(a);
  const rb = getRootProcess(b.businessObject) || findRootContainer(b);
  return ra && rb && ra === rb;
}

function isFlowNode(node) {
  return node && instanceOf(node.businessObject, 'bpmn:FlowNode');
}

function isEvent(node) {
  return node && instanceOf(node.businessObject, 'bpmn:Event');
}

function isStartEvent(node) {
  return node && instanceOf(node.businessObject, 'bpmn:StartEvent');
}

function isEndEvent(node) {
  return node && instanceOf(node.businessObject, 'bpmn:EndEvent');
}

function isDataObjectLike(node) {
  return node && isAny(node.businessObject, [
    'bpmn:DataObject',
    'bpmn:DataObjectReference',
    'bpmn:DataStoreReference',
    'bpmn:DataInput',
    'bpmn:DataOutput'
  ]);
}

function isActivity(node) {
  return node && instanceOf(node.businessObject, 'bpmn:Activity');
}

function isParticipant(node) {
  return node && instanceOf(node.businessObject, 'bpmn:Participant');
}

function isTextAnnotation(node) {
  return node && instanceOf(node.businessObject, 'bpmn:TextAnnotation');
}

function isGroup(node) {
  return node && instanceOf(node.businessObject, 'bpmn:Group');
}

function canSourceSequenceFlow(node) {
  if (!isFlowNode(node)) return false;
  if (isEndEvent(node)) return false; // end events have no outgoing
  return true;
}

function canTargetSequenceFlow(node) {
  if (!isFlowNode(node)) return false;
  if (isStartEvent(node)) return false; // start events have no incoming
  return true;
}

/**
 * Decide which BPMN connection type, if any, is valid from `source`
 * to `target`. Returns the moddle type string or `null`.
 *
 * Type precedence (most specific first):
 *   - DataInputAssociation  (Activity ← DataObject/Store)
 *   - DataOutputAssociation (Activity → DataObject/Store)
 *   - Association           (text annotation / group endpoints)
 *   - MessageFlow           (cross-pool flow nodes)
 *   - SequenceFlow          (same-process flow nodes)
 */
export function getConnectionType(source, target) {
  if (!source || !target || source === target) return null;

  // Associations to/from text annotations or groups
  if (isTextAnnotation(source) || isTextAnnotation(target) ||
      isGroup(source) || isGroup(target)) {
    return 'bpmn:Association';
  }

  // Data associations
  if (isActivity(source) && isDataObjectLike(target)) {
    return 'bpmn:DataOutputAssociation';
  }
  if (isDataObjectLike(source) && isActivity(target)) {
    return 'bpmn:DataInputAssociation';
  }
  if (isDataObjectLike(source) || isDataObjectLike(target)) {
    // any other connection involving data ⇒ Association
    return 'bpmn:Association';
  }

  // Participant-to-participant or any cross-pool flow ⇒ MessageFlow
  const crossPool = !isSameProcess(source, target);
  if (crossPool) {
    if (canSourceSequenceFlow(source) && canTargetSequenceFlow(target)) {
      return 'bpmn:MessageFlow';
    }
    if (isParticipant(source) || isParticipant(target)) {
      return 'bpmn:MessageFlow';
    }
    return null;
  }

  // Same-process flow nodes ⇒ SequenceFlow
  if (canSourceSequenceFlow(source) && canTargetSequenceFlow(target)) {
    return 'bpmn:SequenceFlow';
  }

  return null;
}

/**
 * Can `node` be a valid drop target for a re-connect of `connection`'s
 * source / target endpoint?
 */
export function canReconnect(connection, side, candidate) {
  if (!candidate || candidate.waypoints) return false;
  const otherSide = side === 'source' ? connection.target : connection.source;
  if (!otherSide) return false;
  const inferred = side === 'source'
    ? getConnectionType(candidate, otherSide)
    : getConnectionType(otherSide, candidate);
  if (!inferred) return false;
  // Allow widening — original SequenceFlow may become MessageFlow
  // across a pool drop. Caller decides whether to morph the type.
  return inferred;
}

/**
 * Boundary events attach to activities only.
 */
export function canAttachBoundary(boundaryShape, hostShape) {
  return instanceOf(boundaryShape.businessObject, 'bpmn:BoundaryEvent') &&
         instanceOf(hostShape.businessObject, 'bpmn:Activity') &&
         hostShape !== boundaryShape;
}

/**
 * Can `parentCandidate` host `child` (i.e. accept a reparent on drop)?
 */
export function canBeParent(parentCandidate, child) {
  if (!parentCandidate) return false;
  if (parentCandidate === child) return false;
  // Lane / Participant / SubProcess / Process / Collaboration accept children
  return isAny(parentCandidate.businessObject, [
    'bpmn:Lane',
    'bpmn:Participant',
    'bpmn:SubProcess',
    'bpmn:Process',
    'bpmn:Collaboration'
  ]);
}
