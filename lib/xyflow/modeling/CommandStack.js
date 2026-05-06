/**
 * Minimal command stack with undo/redo.
 *
 * A command is `{ name, do, undo, payload? }`. Calling execute(cmd) runs
 * cmd.do() and pushes it onto the stack, dropping any pending redo
 * entries. undo() pops one and runs cmd.undo(); redo() re-applies it.
 */
export default function CommandStack(opts = {}) {
  const undoStack = [];
  const redoStack = [];
  const limit = opts.limit || 200;
  const listeners = new Set();

  function emit() {
    listeners.forEach(l => {
      try { l({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 }); } catch (e) { console.error(e); }
    });
  }

  function execute(cmd) {
    cmd.do();
    undoStack.push(cmd);
    if (undoStack.length > limit) undoStack.shift();
    redoStack.length = 0;
    emit();
  }

  function undo() {
    const cmd = undoStack.pop();
    if (!cmd) return false;
    cmd.undo();
    redoStack.push(cmd);
    emit();
    return true;
  }

  function redo() {
    const cmd = redoStack.pop();
    if (!cmd) return false;
    cmd.do();
    undoStack.push(cmd);
    emit();
    return true;
  }

  function clear() {
    undoStack.length = 0;
    redoStack.length = 0;
    emit();
  }

  function onChange(handler) {
    listeners.add(handler);
    return () => listeners.delete(handler);
  }

  return {
    execute, undo, redo, clear, onChange,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    size: () => undoStack.length
  };
}
