/* Python Flow Lab — browser-only educational Python visualizer */
const $ = (selector) => document.querySelector(selector);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ui = {
  engineStatus: $('#engineStatus'), parseBadge: $('#parseBadge'),
  runBtn: $('#runBtn'), stepBtn: $('#stepBtn'), pauseBtn: $('#pauseBtn'), resetBtn: $('#resetBtn'),
  jumpLine: $('#jumpLine'), jumpBtn: $('#jumpBtn'), speedRange: $('#speedRange'), speedLabel: $('#speedLabel'),
  graphStage: $('#graphStage'), edgeLayer: $('#edgeLayer'), nodesLayer: $('#nodesLayer'), tokensLayer: $('#tokensLayer'), emptyGraph: $('#emptyGraph'), graphScroll: $('#graphScroll'),
  consoleOutput: $('#consoleOutput'), inputForm: $('#inputForm'), inputPrompt: $('#inputPrompt'), inputField: $('#inputField'), clearConsoleBtn: $('#clearConsoleBtn'),
  inspector: $('#inspector'), inspectorTitle: $('#inspectorTitle'), inspectorCode: $('#inspectorCode'), inspectorState: $('#inspectorState'), inspectorHistory: $('#inspectorHistory'), closeInspector: $('#closeInspector'),
  helpBtn: $('#helpBtn'), helpDialog: $('#helpDialog'),
  appShell: $('.app-shell'), workspace: $('.workspace'), workspaceSplitter: $('#workspaceSplitter'), consoleSplitter: $('#consoleSplitter'),
};

const STARTER_CODE = `name = input("Как тебя зовут? ")
points = 0

for i in range(1, 4):
    points += i

if points >= 6:
    message = "Отлично, " + name
else:
    message = "Попробуй ещё"

def decorate(text, times):
    result = ""
    for _ in range(times):
        result = result + "★"
    return result + " " + text

print(decorate(message, 2))`;

const editor = ace.edit('editor');
editor.setTheme('ace/theme/tomorrow_night_eighties');
editor.session.setMode('ace/mode/python');
editor.session.setUseSoftTabs(true);
editor.session.setTabSize(4);
editor.setOptions({
  fontSize: 15,
  showPrintMargin: false,
  highlightActiveLine: true,
  highlightSelectedWord: true,
  enableBasicAutocompletion: false,
  enableLiveAutocompletion: false,
  wrap: true,
});
editor.setValue(STARTER_CODE, -1);

let pyodide = null;
let parseProgram = null;
let parsed = null;
let runtime = null;
let iterator = null;
let currentLineEvent = null;
let isRunning = false;
let waitingForInput = false;
let resumeRunAfterInput = false;
let fastMode = false;
let parseTimer = null;
let editorMarker = null;
let parseVersion = 0;
let nodeElements = new Map();
let nodeLayout = new Map();
let nodeHistory = new Map();
let lastNodeState = new Map();
let selectedNodeId = null;
let staticEdges = [];
let edgePaths = new Map();
let selectedEdgeId = null;
let lastExecutedNodeId = null;
let animationSequence = 0;
let executionVersion = 0;

function safeText(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'function') return '<function>';
  if (value && value.__kind === 'user_function') return `<function ${value.node.name}>`;
  if (Array.isArray(value)) return `[${value.map((v) => safeText(v)).join(', ')}]`;
  if (typeof value === 'object') return `{${Object.entries(value).map(([k,v]) => `${safeText(k)}: ${safeText(v)}`).join(', ')}}`;
  return String(value);
}

function pyString(value) {
  if (typeof value === 'string') return value;
  return safeText(value);
}

function shortValue(value, max = 28) {
  const text = safeText(value);
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function addConsole(text, className = 'console-line') {
  const line = document.createElement('div');
  line.className = className;
  line.textContent = text;
  ui.consoleOutput.append(line);
  ui.consoleOutput.scrollTop = ui.consoleOutput.scrollHeight;
}

function clearConsole(message = 'Консоль очищена.') {
  ui.consoleOutput.innerHTML = '';
  if (message) addConsole(message, 'console-system');
}

function setEngineStatus(text, state = 'loading') {
  ui.engineStatus.className = `status-pill ${state}`;
  ui.engineStatus.innerHTML = `<span class="status-dot"></span>${text}`;
}

function setControls(enabled) {
  ui.runBtn.disabled = !enabled || waitingForInput;
  ui.stepBtn.disabled = !enabled || waitingForInput;
  ui.resetBtn.disabled = !enabled;
  ui.jumpBtn.disabled = !enabled || waitingForInput;
  ui.pauseBtn.disabled = !isRunning;
}

class Env {
  constructor(parent = null, label = 'global') {
    this.parent = parent;
    this.label = label;
    this.values = new Map();
    this.sources = new Map();
  }
  hasLocal(name) { return this.values.has(name); }
  has(name) { return this.values.has(name) || Boolean(this.parent?.has(name)); }
  get(name) {
    if (this.values.has(name)) return this.values.get(name);
    if (this.parent) return this.parent.get(name);
    throw new Error(`NameError: name '${name}' is not defined`);
  }
  source(name) {
    if (this.sources.has(name)) return this.sources.get(name);
    return this.parent?.source(name) ?? null;
  }
  set(name, value, sourceNode = null) {
    this.values.set(name, value);
    if (sourceNode) this.sources.set(name, sourceNode);
  }
  visibleValues() {
    const merged = this.parent ? this.parent.visibleValues() : {};
    for (const [key, value] of this.values) {
      if (!(value && value.__kind === 'user_function')) merged[key] = value;
    }
    return merged;
  }
}

class MiniPythonRuntime {
  constructor(program, nodeIndex) {
    this.program = program;
    this.nodeIndex = nodeIndex;
    this.global = new Env(null, 'global');
    this.steps = 0;
    this.maxSteps = 15000;
  }

  *run() {
    const signal = yield* this.executeBlock(this.program, this.global, { inLoop: false, functionName: null });
    return signal;
  }

  refsForStatement(stmt, env) {
    const names = new Set();
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'Name') names.add(node.id);
      for (const [key, value] of Object.entries(node)) {
        if (['type', 'id', 'line', 'code', 'label', 'kind', 'depth', 'scope', 'target', 'body', 'orelse'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(walk); else walk(value);
      }
    };
    if (stmt.type === 'Assign') walk(stmt.value);
    else if (stmt.type === 'AugAssign') { walk(stmt.target); walk(stmt.value); }
    else if (['If', 'While'].includes(stmt.type)) walk(stmt.test);
    else if (stmt.type === 'For') walk(stmt.iter);
    else if (stmt.type === 'Return') walk(stmt.value);
    else if (stmt.type === 'Expr') walk(stmt.value);

    const builtins = new Set(['print','input','range','len','int','float','str','bool','min','max','abs','round','list']);
    return [...names].filter((name) => env.has(name) && !builtins.has(name)).map((name) => ({
      name, value: env.get(name), from: env.source(name),
    }));
  }

  *executeBlock(statements, env, context) {
    for (const stmt of statements) {
      this.steps += 1;
      if (this.steps > this.maxSteps) throw new Error('Выполнение остановлено: превышен лимит 15 000 шагов. Возможно, цикл бесконечный.');

      yield {
        type: 'line', nodeId: stmt.id, line: stmt.line, code: stmt.code,
        scope: env.label, refs: this.refsForStatement(stmt, env), snapshot: env.visibleValues(),
      };

      let signal = null;
      switch (stmt.type) {
        case 'Assign': {
          const value = yield* this.evalExpr(stmt.value, env, stmt.id);
          this.assignTarget(stmt.target, value, env, stmt.id);
          const name = this.targetLabel(stmt.target);
          yield { type: 'data', nodeId: stmt.id, name, value, snapshot: env.visibleValues() };
          break;
        }
        case 'AugAssign': {
          const current = yield* this.readTarget(stmt.target, env, stmt.id);
          const rhs = yield* this.evalExpr(stmt.value, env, stmt.id);
          const value = this.applyBinOp(stmt.op, current, rhs);
          this.assignTarget(stmt.target, value, env, stmt.id);
          yield { type: 'data', nodeId: stmt.id, name: this.targetLabel(stmt.target), value, snapshot: env.visibleValues() };
          break;
        }
        case 'Expr':
          yield* this.evalExpr(stmt.value, env, stmt.id);
          break;
        case 'If': {
          const condition = Boolean(yield* this.evalExpr(stmt.test, env, stmt.id));
          yield { type: 'decision', nodeId: stmt.id, value: condition, snapshot: env.visibleValues() };
          const branch = condition ? stmt.body : stmt.orelse;
          signal = yield* this.executeBlock(branch, env, context);
          break;
        }
        case 'While': {
          let iterations = 0;
          while (Boolean(yield* this.evalExpr(stmt.test, env, stmt.id))) {
            iterations += 1;
            yield { type: 'decision', nodeId: stmt.id, value: true, label: `итерация ${iterations}`, snapshot: env.visibleValues() };
            signal = yield* this.executeBlock(stmt.body, env, { ...context, inLoop: true });
            if (signal?.kind === 'return') return signal;
            if (signal?.kind === 'break') { signal = null; break; }
            signal = null;
            // Revisiting the condition is a real execution step, so surface it again.
            this.steps += 1;
            yield { type: 'line', nodeId: stmt.id, line: stmt.line, code: stmt.code, scope: env.label, refs: this.refsForStatement(stmt, env), snapshot: env.visibleValues() };
            if (this.steps > this.maxSteps) throw new Error('Выполнение остановлено: возможно, цикл бесконечный.');
          }
          yield { type: 'decision', nodeId: stmt.id, value: false, label: 'выход', snapshot: env.visibleValues() };
          break;
        }
        case 'For': {
          const iterable = yield* this.evalExpr(stmt.iter, env, stmt.id);
          const items = Array.from(iterable ?? []);
          let index = 0;
          for (const item of items) {
            index += 1;
            this.assignTarget(stmt.target, item, env, stmt.id);
            yield { type: 'data', nodeId: stmt.id, name: this.targetLabel(stmt.target), value: item, snapshot: env.visibleValues(), label: `${index}/${items.length}` };
            signal = yield* this.executeBlock(stmt.body, env, { ...context, inLoop: true });
            if (signal?.kind === 'return') return signal;
            if (signal?.kind === 'break') { signal = null; break; }
            signal = null;
            if (index < items.length) {
              this.steps += 1;
              yield { type: 'line', nodeId: stmt.id, line: stmt.line, code: stmt.code, scope: env.label, refs: this.refsForStatement(stmt, env), snapshot: env.visibleValues() };
            }
          }
          yield { type: 'decision', nodeId: stmt.id, value: false, label: 'цикл завершён', snapshot: env.visibleValues() };
          break;
        }
        case 'FunctionDef': {
          const fn = { __kind: 'user_function', node: stmt, closure: env };
          env.set(stmt.name, fn, stmt.id);
          yield { type: 'data', nodeId: stmt.id, name: stmt.name, value: fn, snapshot: env.visibleValues(), label: 'функция создана' };
          break;
        }
        case 'Return': {
          const value = stmt.value ? (yield* this.evalExpr(stmt.value, env, stmt.id)) : null;
          yield { type: 'data', nodeId: stmt.id, name: 'return', value, snapshot: env.visibleValues() };
          return { kind: 'return', value, nodeId: stmt.id };
        }
        case 'Break':
          if (!context.inLoop) throw new Error('SyntaxError: break вне цикла');
          return { kind: 'break' };
        case 'Continue':
          if (!context.inLoop) throw new Error('SyntaxError: continue вне цикла');
          return { kind: 'continue' };
        case 'Pass':
          break;
        default:
          throw new Error(`Конструкция ${stmt.type} не поддерживается`);
      }
      if (signal) return signal;
    }
    return null;
  }

  *evalExpr(node, env, currentNodeId) {
    if (!node) return null;
    switch (node.type) {
      case 'Constant': return node.value;
      case 'Name': return env.get(node.id);
      case 'List': {
        const out = [];
        for (const item of node.elts) out.push(yield* this.evalExpr(item, env, currentNodeId));
        return out;
      }
      case 'Tuple': {
        const out = [];
        for (const item of node.elts) out.push(yield* this.evalExpr(item, env, currentNodeId));
        return out;
      }
      case 'Dict': {
        const out = {};
        for (let i = 0; i < node.keys.length; i++) {
          const key = yield* this.evalExpr(node.keys[i], env, currentNodeId);
          out[key] = yield* this.evalExpr(node.values[i], env, currentNodeId);
        }
        return out;
      }
      case 'BinOp': {
        const left = yield* this.evalExpr(node.left, env, currentNodeId);
        const right = yield* this.evalExpr(node.right, env, currentNodeId);
        return this.applyBinOp(node.op, left, right);
      }
      case 'UnaryOp': {
        const value = yield* this.evalExpr(node.operand, env, currentNodeId);
        if (node.op === 'Not') return !value;
        if (node.op === 'USub') return -value;
        if (node.op === 'UAdd') return +value;
        throw new Error(`Оператор ${node.op} не поддерживается`);
      }
      case 'BoolOp': {
        if (node.op === 'And') {
          let value = true;
          for (const part of node.values) { value = yield* this.evalExpr(part, env, currentNodeId); if (!value) return value; }
          return value;
        }
        let value = false;
        for (const part of node.values) { value = yield* this.evalExpr(part, env, currentNodeId); if (value) return value; }
        return value;
      }
      case 'Compare': {
        let left = yield* this.evalExpr(node.left, env, currentNodeId);
        for (let i = 0; i < node.ops.length; i++) {
          const right = yield* this.evalExpr(node.comparators[i], env, currentNodeId);
          if (!this.compare(node.ops[i], left, right)) return false;
          left = right;
        }
        return true;
      }
      case 'IfExp': {
        const test = yield* this.evalExpr(node.test, env, currentNodeId);
        return yield* this.evalExpr(test ? node.body : node.orelse, env, currentNodeId);
      }
      case 'Subscript': {
        const target = yield* this.evalExpr(node.value, env, currentNodeId);
        const index = yield* this.evalSlice(node.slice, env, currentNodeId);
        if (index && index.__slice) return target.slice(index.start, index.stop, index.step || 1);
        return target[index];
      }
      case 'Attribute': {
        const target = yield* this.evalExpr(node.value, env, currentNodeId);
        return { __kind: 'attribute', target, attr: node.attr };
      }
      case 'Call': {
        return yield* this.evalCall(node, env, currentNodeId);
      }
      default: throw new Error(`Выражение ${node.type} не поддерживается`);
    }
  }

  *evalSlice(node, env, currentNodeId) {
    if (node.type !== 'Slice') return yield* this.evalExpr(node, env, currentNodeId);
    const start = node.lower ? (yield* this.evalExpr(node.lower, env, currentNodeId)) : undefined;
    const stop = node.upper ? (yield* this.evalExpr(node.upper, env, currentNodeId)) : undefined;
    const step = node.step ? (yield* this.evalExpr(node.step, env, currentNodeId)) : undefined;
    return { __slice: true, start, stop, step };
  }

  *evalCall(node, env, currentNodeId) {
    let callableName = null;
    let callable = null;
    if (node.func.type === 'Name') {
      callableName = node.func.id;
      if (env.has(callableName)) callable = env.get(callableName);
    } else {
      callable = yield* this.evalExpr(node.func, env, currentNodeId);
    }

    const args = [];
    for (const arg of node.args) args.push(yield* this.evalExpr(arg, env, currentNodeId));

    if (callable?.__kind === 'user_function') {
      return yield* this.callUserFunction(callable, args, currentNodeId);
    }
    if (callable?.__kind === 'attribute') {
      return this.callAttribute(callable, args);
    }

    switch (callableName) {
      case 'print': {
        const text = args.map(pyString).join(' ');
        yield { type: 'output', nodeId: currentNodeId, text };
        return null;
      }
      case 'input': {
        const prompt = args.length ? String(args[0]) : '';
        const answer = yield { type: 'input', nodeId: currentNodeId, prompt };
        return String(answer ?? '');
      }
      case 'range': return this.pyRange(args);
      case 'len': return args[0]?.length ?? Object.keys(args[0] ?? {}).length;
      case 'int': return Number.parseInt(args[0] ?? 0, 10);
      case 'float': return Number(args[0] ?? 0);
      case 'str': return pyString(args[0]);
      case 'bool': return Boolean(args[0]);
      case 'min': return Math.min(...(Array.isArray(args[0]) && args.length === 1 ? args[0] : args));
      case 'max': return Math.max(...(Array.isArray(args[0]) && args.length === 1 ? args[0] : args));
      case 'abs': return Math.abs(args[0]);
      case 'round': return Number(Number(args[0]).toFixed(args[1] ?? 0));
      case 'list': return Array.from(args[0] ?? []);
      default:
        throw new Error(`NameError: функция '${callableName ?? '?'}' не определена или не поддерживается`);
    }
  }

  *callUserFunction(fn, args, callNodeId) {
    const node = fn.node;
    const local = new Env(fn.closure, node.name);
    const required = node.args.length - node.defaults.length;
    if (args.length < required || args.length > node.args.length) {
      throw new Error(`TypeError: ${node.name}() ожидает ${required === node.args.length ? required : `${required}–${node.args.length}`} арг., получено ${args.length}`);
    }
    const defaultOffset = node.args.length - node.defaults.length;
    for (let i = 0; i < node.args.length; i++) {
      let value;
      if (i < args.length) value = args[i];
      else value = yield* this.evalExpr(node.defaults[i - defaultOffset], fn.closure, callNodeId);
      local.set(node.args[i], value, callNodeId);
    }
    yield { type: 'call', from: callNodeId, to: node.id, name: node.name, args };
    const signal = yield* this.executeBlock(node.body, local, { inLoop: false, functionName: node.name });
    if (signal?.kind === 'return') {
      yield { type: 'return', from: signal.nodeId, to: callNodeId, value: signal.value };
    }
    return signal?.kind === 'return' ? signal.value : null;
  }

  callAttribute(callable, args) {
    const { target, attr } = callable;
    if (attr === 'append' && Array.isArray(target)) { target.push(args[0]); return null; }
    if (attr === 'pop' && Array.isArray(target)) return target.pop(args[0]);
    if (attr === 'upper' && typeof target === 'string') return target.toUpperCase();
    if (attr === 'lower' && typeof target === 'string') return target.toLowerCase();
    throw new Error(`Метод .${attr}() пока не поддерживается`);
  }

  pyRange(args) {
    let start = 0, stop = 0, step = 1;
    if (args.length === 1) stop = Number(args[0]);
    else if (args.length >= 2) { start = Number(args[0]); stop = Number(args[1]); step = Number(args[2] ?? 1); }
    if (step === 0) throw new Error('ValueError: range() arg 3 must not be zero');
    const out = [];
    if (step > 0) for (let i = start; i < stop; i += step) out.push(i);
    else for (let i = start; i > stop; i += step) out.push(i);
    return out;
  }

  applyBinOp(op, a, b) {
    switch (op) {
      case 'Add':
        if (typeof a === 'number' && typeof b === 'number') return a + b;
        if (typeof a === 'string' && typeof b === 'string') return a + b;
        if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
        throw new Error(`TypeError: нельзя сложить ${typeof a} и ${typeof b}`);
      case 'Sub': return a - b;
      case 'Mult':
        if (typeof a === 'string' && Number.isInteger(b)) return a.repeat(Math.max(0, b));
        if (typeof b === 'string' && Number.isInteger(a)) return b.repeat(Math.max(0, a));
        if (Array.isArray(a) && Number.isInteger(b)) return Array.from({length: Math.max(0,b)}, () => a).flat();
        if (Array.isArray(b) && Number.isInteger(a)) return Array.from({length: Math.max(0,a)}, () => b).flat();
        return a * b;
      case 'Div':
        if (b === 0) throw new Error('ZeroDivisionError: division by zero');
        return a / b;
      case 'FloorDiv':
        if (b === 0) throw new Error('ZeroDivisionError: integer division or modulo by zero');
        return Math.floor(a / b);
      case 'Mod':
        if (b === 0) throw new Error('ZeroDivisionError: integer modulo by zero');
        return ((a % b) + b) % b;
      case 'Pow': return a ** b;
      default: throw new Error(`Оператор ${op} не поддерживается`);
    }
  }

  compare(op, a, b) {
    switch (op) {
      case 'Eq': return a === b;
      case 'NotEq': return a !== b;
      case 'Lt': return a < b;
      case 'LtE': return a <= b;
      case 'Gt': return a > b;
      case 'GtE': return a >= b;
      case 'In': return Array.isArray(b) ? b.includes(a) : String(b).includes(String(a));
      case 'NotIn': return !(Array.isArray(b) ? b.includes(a) : String(b).includes(String(a)));
      case 'Is': return a === b;
      case 'IsNot': return a !== b;
      default: throw new Error(`Сравнение ${op} не поддерживается`);
    }
  }

  targetLabel(target) {
    return target.type === 'Name' ? target.id : 'элемент';
  }

  *readTarget(target, env, currentNodeId) {
    if (target.type === 'Name') return env.get(target.id);
    if (target.type === 'Subscript') {
      const object = yield* this.evalExpr(target.value, env, currentNodeId);
      const key = yield* this.evalSlice(target.slice, env, currentNodeId);
      return object[key];
    }
    throw new Error('Цель присваивания не поддерживается');
  }

  assignTarget(target, value, env, sourceNode) {
    if (target.type === 'Name') { env.set(target.id, value, sourceNode); return; }
    if (target.type === 'Subscript') {
      // Subscript targets are intentionally limited to simple name[index].
      if (target.value.type !== 'Name') throw new Error('Сложное присваивание по индексу пока не поддерживается');
      const object = env.get(target.value.id);
      const slice = target.slice;
      let key;
      if (slice.type === 'Constant') key = slice.value;
      else if (slice.type === 'Name') key = env.get(slice.id);
      else throw new Error('В индексе присваивания используйте число, строку или переменную');
      object[key] = value;
      env.set(target.value.id, object, sourceNode);
      return;
    }
    throw new Error('Цель присваивания не поддерживается');
  }
}

function flattenNodeIndex(nodes) {
  return new Map(nodes.map((node) => [node.id, node]));
}

function buildStaticEdges(program) {
  const edges = [];
  const add = (from, to, kind = 'normal', label = 'Next') => {
    if (from && to) edges.push({ from, to, kind, label, id: `${from}:${label || 'Next'}:${to}` });
  };

  function walkBlock(stmts, continuation = null) {
    stmts.forEach((stmt, index) => {
      const next = stmts[index + 1]?.id ?? continuation;
      if (stmt.type === 'If') {
        add(stmt.id, stmt.body[0]?.id ?? next, 'branch true', 'True');
        add(stmt.id, stmt.orelse[0]?.id ?? next, 'branch false', 'False');
        walkBlock(stmt.body, next);
        walkBlock(stmt.orelse, next);
      } else if (stmt.type === 'While' || stmt.type === 'For') {
        add(stmt.id, stmt.body[0]?.id, 'loop', 'Loop Body');
        add(stmt.id, next, 'branch completed', 'Completed');
        walkBlock(stmt.body, stmt.id);
      } else if (stmt.type === 'FunctionDef') {
        add(stmt.id, next, 'normal', 'Next');
        add(stmt.id, stmt.body[0]?.id, 'branch', 'Call');
        walkBlock(stmt.body, null);
      } else if (stmt.type !== 'Return' && stmt.type !== 'Break' && stmt.type !== 'Continue') {
        add(stmt.id, next, 'normal', 'Next');
      }
    });
  }
  walkBlock(program, null);
  return edges.filter((edge, i, arr) => edge.from !== edge.to && arr.findIndex(e => e.from === edge.from && e.to === edge.to && e.label === edge.label) === i);
}

function renderGraph(data) {
  const previousPositions = new Map([...nodeLayout].map(([id, box]) => [id, { ...box }]));
  ui.nodesLayer.innerHTML = '';
  ui.edgeLayer.innerHTML = '';
  ui.tokensLayer.innerHTML = '';
  nodeElements.clear();
  nodeLayout.clear();
  nodeHistory.clear();
  lastNodeState.clear();
  selectedNodeId = null;
  staticEdges = [];
  edgePaths.clear();
  selectedEdgeId = null;
  ui.inspector.classList.remove('open');
  ui.inspector.setAttribute('aria-hidden', 'true');

  if (!data?.nodes?.length) {
    ui.emptyGraph.classList.remove('hidden');
    updateGraphBounds();
    if (typeof graphRebuilt === 'function') graphRebuilt();
    return;
  }
  ui.emptyGraph.classList.add('hidden');

  let nextX = 42;
  data.nodes.forEach((node) => {
    const x = nextX;
    const y = 96;

    const el = document.createElement('article');
    el.className = `code-node kind-${node.kind}`;
    el.dataset.id = node.id;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.innerHTML = `
      <div class="node-port input-port" data-port="Exec"><i></i><span>Exec</span></div>
      <div class="node-top"><span class="node-kind">${node.kind}</span><span class="node-line">стр. ${node.line}</span></div>
      <div class="node-body">
        <div class="node-label"></div>
        <div class="node-runtime"><span class="value-chip" style="opacity:.38">runtime: —</span></div>
        <div class="node-scope"></div>
      </div>`;
    el.querySelector('.node-label').textContent = node.label;
    el.querySelector('.node-scope').textContent = node.scope === 'module' ? 'глобальная область' : `функция ${node.scope}()`;
    el.tabIndex = 0;
    el.setAttribute('aria-label', `Строка ${node.line}: ${node.code}`);
    el.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectGraphNode(node.id, event.shiftKey);
        if (!event.shiftKey) openInspector(node.id);
      }
    });
    el.addEventListener('click', (event) => {
      selectGraphNode(node.id, event.shiftKey);
      if (!event.shiftKey) openInspector(node.id);
    });
    ui.nodesLayer.append(el);
    nodeElements.set(node.id, el);
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    nodeLayout.set(node.id, { x, y, width, height });
    nextX += width + 160;
    installNodeDrag(el, node.id);
  });

  staticEdges = buildStaticEdges(data.program);
  const outgoing = new Map();
  for (const edge of staticEdges) {
    const list = outgoing.get(edge.from) ?? [];
    if (!list.includes(edge.label)) list.push(edge.label);
    outgoing.set(edge.from, list);
  }
  for (const node of data.nodes) {
    if (node.type === 'Return') outgoing.set(node.id, ['Return']);
  }
  outgoing.forEach((labels, nodeId) => {
    const el = nodeElements.get(nodeId);
    labels.forEach((label, index) => {
      const port = document.createElement('div');
      port.className = `node-port output-port port-${label.toLowerCase().replace(/\s+/g, '-')}`;
      port.dataset.port = label;
      port.style.setProperty('--port-y', `${((index + 1) / (labels.length + 1)) * 100}%`);
      port.innerHTML = `<span></span><i></i>`;
      port.querySelector('span').textContent = label;
      el.append(port);
    });
  });
  updateGraphBounds();
  drawEdges(staticEdges);
  if (typeof graphRebuilt === 'function') graphRebuilt(previousPositions);
}

function updateGraphBounds(minWidth = 720, minHeight = 560) {
  let width = minWidth, height = minHeight;
  nodeLayout.forEach((box) => {
    width = Math.max(width, box.x + box.width + 90);
    height = Math.max(height, box.y + box.height + 90);
  });
  ui.graphStage.style.width = `${Math.ceil(width)}px`;
  ui.graphStage.style.height = `${Math.ceil(height)}px`;
  ui.edgeLayer.setAttribute('viewBox', `0 0 ${Math.ceil(width)} ${Math.ceil(height)}`);
  ui.edgeLayer.setAttribute('width', Math.ceil(width));
  ui.edgeLayer.setAttribute('height', Math.ceil(height));
}

function drawEdges(edges) {
  const ns = 'http://www.w3.org/2000/svg';
  ui.edgeLayer.innerHTML = '';
  edgePaths.clear();
  const defs = document.createElementNS(ns, 'defs');
  defs.innerHTML = '<marker id="edgeArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L8 4L0 8z" class="edge-arrow"/></marker>';
  ui.edgeLayer.append(defs);
  // Read actual socket centers and convert viewport coordinates into SVG space.
  // This also accounts for CSS zoom, scrolling and labels of different widths.
  const inverse = ui.edgeLayer.getScreenCTM()?.inverse();
  if (!inverse) return;
  const ports = new Map();
  nodeElements.forEach((el, id) => {
    const points = new Map();
    el.querySelectorAll('.node-port').forEach(port => {
      const rect = port.querySelector('i').getBoundingClientRect();
      const point = new DOMPoint(rect.left + rect.width / 2, rect.top + rect.height / 2).matrixTransform(inverse);
      points.set(port.classList.contains('input-port') ? 'input' : port.dataset.port, point);
    });
    ports.set(id, points);
  });
  for (const edge of edges) {
    const a = nodeLayout.get(edge.from), b = nodeLayout.get(edge.to);
    if (!a || !b) continue;
    const source = ports.get(edge.from)?.get(edge.label);
    const target = ports.get(edge.to)?.get('input');
    if (!source || !target) continue;
    const { x: sx, y: sy } = source;
    const { x: tx, y: ty } = target;
    const dx = tx - sx;
    const offset = Math.min(220, Math.max(42, Math.abs(dx) * .5));
    const c1x = sx + offset;
    const c2x = tx - offset;
    const returnY = Math.max(12, Math.min(a.y, b.y) - 40);
    const d = dx > 0
      ? `M ${sx} ${sy} C ${c1x} ${sy}, ${c2x} ${ty}, ${tx} ${ty}`
      : `M ${sx} ${sy} C ${c1x} ${sy}, ${c1x} ${returnY}, ${sx} ${returnY} L ${tx} ${returnY} C ${c2x} ${returnY}, ${c2x} ${ty}, ${tx} ${ty}`;
    const hit = document.createElementNS(ns, 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'flow-edge-hit');
    hit.dataset.edgeId = edge.id;
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', `flow-edge ${edge.kind}${selectedEdgeId === edge.id ? ' selected' : ''}`);
    path.dataset.edgeId = edge.id;
    path.setAttribute('marker-end', 'url(#edgeArrow)');
    hit.addEventListener('click', () => { selectedEdgeId = edge.id; drawEdges(staticEdges); });
    ui.edgeLayer.append(hit);
    ui.edgeLayer.append(path);
    edgePaths.set(edge.id, path);
  }
}

function installNodeDrag(el, nodeId) {
  let drag = null;
  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.shiftKey) return;
    if (!graphSelection.has(nodeId)) selectGraphNode(nodeId);
    ui.graphScroll.focus({ preventScroll: true });
    const positions = snapshotLayout();
    const box = nodeLayout.get(nodeId);
    drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: box.x, y: box.y, moved: false, positions };
    el.setPointerCapture(event.pointerId);
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    let dx = (event.clientX - drag.startX) / graphZoom, dy = (event.clientY - drag.startY) / graphZoom;
    if (Math.hypot(dx, dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    if ($('#snapGrid').checked) {
      dx = Math.round((drag.x + dx) / 22) * 22 - drag.x;
      dy = Math.round((drag.y + dy) / 22) * 22 - drag.y;
    }
    moveGraphSelection(drag.positions, dx, dy);
  });
  const finish = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    el.releasePointerCapture(event.pointerId);
    el.classList.remove('dragging');
    if (drag.moved) {
      commitLayout(drag.positions);
      el.dataset.justDragged = 'true';
      updateGraphBounds();
      drawEdges(staticEdges);
    }
    drag = null;
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  el.addEventListener('click', (event) => {
    if (el.dataset.justDragged) {
      delete el.dataset.justDragged;
      event.stopImmediatePropagation();
    }
  }, true);
}

function separateOverlappingNode(nodeId) {
  const box = nodeLayout.get(nodeId);
  if (!box) return;
  for (let pass = 0; pass < nodeLayout.size; pass++) {
    const collision = [...nodeLayout.entries()].find(([id, other]) => id !== nodeId &&
      box.x < other.x + other.width + 16 && box.x + box.width + 16 > other.x &&
      box.y < other.y + other.height + 16 && box.y + box.height + 16 > other.y);
    if (!collision) break;
    const other = collision[1];
    box.y = other.y + other.height + 24;
  }
  const el = nodeElements.get(nodeId);
  el.style.left = `${box.x}px`;
  el.style.top = `${box.y}px`;
}

function recordNode(nodeId, record) {
  if (!nodeId) return;
  const list = nodeHistory.get(nodeId) ?? [];
  list.push({ time: list.length + 1, ...record });
  if (list.length > 20) list.shift();
  nodeHistory.set(nodeId, list);
  if (record.snapshot) lastNodeState.set(nodeId, record.snapshot);
  if (selectedNodeId === nodeId) refreshInspector(nodeId);
}

function updateNodeChip(nodeId, label, value) {
  const el = nodeElements.get(nodeId);
  if (!el) return;
  const runtimeBox = el.querySelector('.node-runtime');
  runtimeBox.innerHTML = '';
  const chip = document.createElement('span');
  chip.className = 'value-chip';
  chip.textContent = `${label}: ${shortValue(value)}`;
  runtimeBox.append(chip);
  el.classList.add('done');
  const box = nodeLayout.get(nodeId);
  if (box) {
    box.height = el.offsetHeight;
    updateGraphBounds();
    drawEdges(staticEdges);
  }
}

function markCurrentNode(nodeId) {
  nodeElements.forEach((el) => el.classList.remove('active'));
  const el = nodeElements.get(nodeId);
  if (el) {
    el.classList.add('active');
    if (!fastMode && $('#followNode')?.checked && typeof focusGraphNode === 'function') focusGraphNode(nodeId);
  }
}

function markEditorLine(line) {
  if (editorMarker !== null) editor.session.removeMarker(editorMarker);
  const Range = ace.require('ace/range').Range;
  editorMarker = editor.session.addMarker(new Range(line - 1, 0, line - 1, 1), 'current-exec-line', 'fullLine');
  if (!fastMode) editor.scrollToLine(line, true, true, () => {});
}

function dataTypeOf(value) {
  if (Array.isArray(value)) return 'list';
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string' || typeof value === 'boolean') return typeof value;
  return typeof value === 'object' ? 'object' : 'unknown';
}

function findEdge(fromId, toId, label = null, createDataEdge = false) {
  let edge = staticEdges.find((item) => item.from === fromId && item.to === toId &&
    (createDataEdge ? item.kind.includes('data') && (!label || item.label === label) : (!label || item.label === label)));
  if (!edge && createDataEdge && nodeLayout.has(fromId) && nodeLayout.has(toId)) {
    const portLabel = label || 'Value';
    edge = { from: fromId, to: toId, kind: 'data unknown', label: portLabel, id: `${fromId}:${portLabel}:${toId}` };
    staticEdges.push(edge);
    const source = nodeElements.get(fromId);
    if (source && ![...source.querySelectorAll('.output-port')].some(port => port.dataset.port === portLabel)) {
      const port = document.createElement('div');
      port.className = 'node-port output-port port-value';
      port.dataset.port = portLabel;
      port.style.setProperty('--port-y', '50%');
      port.innerHTML = '<span></span><i></i>';
      port.querySelector('span').textContent = portLabel;
      source.append(port);
      const outputs = source.querySelectorAll('.output-port');
      outputs.forEach((output, index) => output.style.setProperty('--port-y', `${(index + 1) / (outputs.length + 1) * 100}%`));
    }
    drawEdges(staticEdges);
  }
  return edge;
}

function animateEdge(edge, { value = '', dataType = 'unknown', execution = false } = {}) {
  if (!edge || fastMode || !edgePaths.has(edge.id)) return;
  edgePaths.get(edge.id).classList.add('active-edge');
  const packet = document.createElement('div');
  const duration = Math.max(160, Math.min(650, Number(ui.speedRange.value) * .82));
  packet.className = execution || duration < 180 ? 'edge-pulse' : `data-token type-${dataType}`;
  if (!execution && duration >= 180) packet.textContent = shortValue(value, 18);
  packet.dataset.animationId = String(++animationSequence);
  ui.tokensLayer.append(packet);
  const startedAt = performance.now();
  const tick = (now) => {
    const path = edgePaths.get(edge.id);
    if (!path || !packet.isConnected) return;
    const progress = Math.min(1, (now - startedAt) / duration);
    const point = path.getPointAtLength(progress * path.getTotalLength());
    packet.style.left = `${point.x}px`;
    packet.style.top = `${point.y}px`;
    packet.style.opacity = String(Math.min(1, progress * 7, (1 - progress) * 7));
    if (progress < 1) requestAnimationFrame(tick);
    else {
      packet.remove();
      window.setTimeout(() => edgePaths.get(edge.id)?.classList.remove('active-edge'), 420);
    }
  };
  requestAnimationFrame(tick);
}

function animateToken(fromId, toId, value, label = '', portLabel = 'Value') {
  const type = dataTypeOf(value);
  const edge = findEdge(fromId, toId, portLabel, true);
  if (edge?.kind.includes('data') && !edge.kind.includes(type)) {
    edge.kind = `data ${type}`;
    drawEdges(staticEdges);
  }
  animateEdge(edge, { value: label ? `${label}=${shortValue(value, 16)}` : value, dataType: type });
}

function handleEvent(event) {
  if (!event) return;
  switch (event.type) {
    case 'line':
      if (lastExecutedNodeId && lastExecutedNodeId !== event.nodeId) {
        animateEdge(findEdge(lastExecutedNodeId, event.nodeId), { execution: true });
      }
      currentLineEvent = event;
      lastExecutedNodeId = event.nodeId;
      markCurrentNode(event.nodeId);
      markEditorLine(event.line);
      for (const ref of event.refs ?? []) animateToken(ref.from, event.nodeId, ref.value, ref.name);
      recordNode(event.nodeId, { kind: 'line', label: `вход: стр. ${event.line}`, snapshot: event.snapshot });
      break;
    case 'data':
      updateNodeChip(event.nodeId, event.name, event.value);
      recordNode(event.nodeId, { kind: 'data', label: `${event.name} = ${shortValue(event.value, 60)}`, snapshot: event.snapshot });
      break;
    case 'decision':
      updateNodeChip(event.nodeId, event.label || 'условие', event.value);
      {
        const labels = event.value ? ['True', 'Loop Body'] : ['False', 'Completed'];
        const edge = staticEdges.find((item) => item.from === event.nodeId && labels.includes(item.label));
        animateEdge(edge, { execution: true });
      }
      recordNode(event.nodeId, { kind: 'decision', label: `${event.label || 'условие'} → ${event.value}`, snapshot: event.snapshot });
      break;
    case 'output':
      addConsole(event.text, 'console-line');
      updateNodeChip(event.nodeId, 'print', event.text);
      recordNode(event.nodeId, { kind: 'output', label: `print → ${event.text}` });
      break;
    case 'call':
      animateToken(event.from, event.to, event.args, event.name);
      recordNode(event.to, { kind: 'call', label: `вызов ${event.name}(${event.args.map(a => shortValue(a, 12)).join(', ')})` });
      break;
    case 'return':
      animateToken(event.from, event.to, event.value, 'return', 'Return');
      break;
  }
}

async function pumpToNextPause(inputValue = undefined) {
  if (!iterator) return 'done';
  let result;
  try {
    result = iterator.next(inputValue);
    while (!result.done) {
      const event = result.value;
      if (event.type === 'line') {
        handleEvent(event);
        return 'line';
      }
      if (event.type === 'input') {
        waitingForInput = true;
        setControls(Boolean(parsed?.ok));
        ui.inputPrompt.textContent = event.prompt || 'Введите значение:';
        ui.inputForm.classList.remove('hidden');
        ui.inputField.value = '';
        ui.inputField.focus();
        updateNodeChip(event.nodeId, 'input', 'ожидание…');
        recordNode(event.nodeId, { kind: 'input', label: `input: ${event.prompt || ''}` });
        return 'input';
      }
      handleEvent(event);
      result = iterator.next();
    }
    finishExecution();
    return 'done';
  } catch (error) {
    handleRuntimeError(error);
    return 'error';
  }
}

function finishExecution() {
  isRunning = false;
  waitingForInput = false;
  currentLineEvent = null;
  lastExecutedNodeId = null;
  ui.pauseBtn.disabled = true;
  ui.runBtn.textContent = '▶ Снова';
  addConsole('✓ Выполнение завершено.', 'console-system');
  nodeElements.forEach((el) => el.classList.remove('active'));
  setControls(Boolean(parsed?.ok));
}

function handleRuntimeError(error) {
  isRunning = false;
  waitingForInput = false;
  const message = error?.message || String(error);
  addConsole(`Ошибка: ${message}`, 'console-error');
  const active = currentLineEvent?.nodeId && nodeElements.get(currentLineEvent.nodeId);
  active?.classList.add('error');
  ui.inputForm.classList.add('hidden');
  setControls(Boolean(parsed?.ok));
}

async function resetRuntime({ clear = true, prime = true } = {}) {
  executionVersion++;
  ui.tokensLayer.replaceChildren();
  isRunning = false;
  waitingForInput = false;
  resumeRunAfterInput = false;
  ui.inputForm.classList.add('hidden');
  ui.runBtn.textContent = '▶ Запуск';
  if (editorMarker !== null) { editor.session.removeMarker(editorMarker); editorMarker = null; }
  nodeElements.forEach((el) => {
    el.classList.remove('active', 'done', 'error');
    el.querySelector('.node-runtime').innerHTML = '<span class="value-chip" style="opacity:.38">runtime: —</span>';
  });
  nodeHistory.clear(); lastNodeState.clear();
  nodeElements.forEach((el, id) => { nodeLayout.get(id).height = el.offsetHeight; });
  updateGraphBounds();
  drawEdges(staticEdges);
  if (selectedNodeId) refreshInspector(selectedNodeId);
  if (clear) clearConsole('Среда сброшена. Выполнение начнётся с первой строки.');
  if (!parsed?.ok) return;
  runtime = new MiniPythonRuntime(parsed.program, flattenNodeIndex(parsed.nodes));
  iterator = runtime.run();
  currentLineEvent = null;
  lastExecutedNodeId = null;
  if (prime) await pumpToNextPause();
  setControls(true);
}

async function stepOnce() {
  if (waitingForInput || !iterator) return;
  if (!currentLineEvent) { await resetRuntime({ clear: true, prime: true }); return; }
  await pumpToNextPause();
}

async function runLoop() {
  if (isRunning) return;
  if (!parsed?.ok || waitingForInput) return;
  if (!iterator || !currentLineEvent) await resetRuntime({ clear: true, prime: true });
  isRunning = true;
  const version = ++executionVersion;
  ui.runBtn.textContent = '▶ Выполняется';
  setControls(true);
  ui.runBtn.disabled = true;
  ui.stepBtn.disabled = true;
  ui.jumpBtn.disabled = true;
  while (isRunning && iterator && currentLineEvent) {
    await sleep(Number(ui.speedRange.value));
    if (!isRunning || version !== executionVersion) return;
    const state = await pumpToNextPause();
    if (state === 'input') {
      resumeRunAfterInput = true;
      isRunning = false;
      ui.pauseBtn.disabled = true;
      break;
    }
    if (state === 'done' || state === 'error') break;
  }
  if (!waitingForInput && iterator) setControls(Boolean(parsed?.ok));
}

function pauseRun() {
  executionVersion++;
  isRunning = false;
  ui.runBtn.textContent = '▶ Продолжить';
  setControls(Boolean(parsed?.ok));
}

async function jumpToLine(target) {
  if (!parsed?.ok) return;
  target = Number(target);
  if (!Number.isInteger(target) || target < 1) return;
  await resetRuntime({ clear: true, prime: true });
  fastMode = true;
  addConsole(`⇢ Быстрый прогон до строки ${target}…`, 'console-system');
  let guard = 0;
  while (currentLineEvent && currentLineEvent.line !== target && guard++ < 8000) {
    const state = await pumpToNextPause();
    if (state === 'input') {
      fastMode = false;
      addConsole('Для продолжения перехода нужен input(). Введите значение в консоли.', 'console-system');
      return;
    }
    if (state === 'done' || state === 'error') break;
  }
  fastMode = false;
  if (currentLineEvent?.line === target) {
    markCurrentNode(currentLineEvent.nodeId); markEditorLine(target);
    addConsole(`✓ Остановлено перед выполнением строки ${target}.`, 'console-system');
  } else if (guard >= 8000) addConsole('Переход остановлен по лимиту шагов.', 'console-error');
  else addConsole(`Строка ${target} не была выполнена в этом сценарии.`, 'console-system');
}

function openInspector(nodeId) {
  selectedNodeId = nodeId;
  ui.inspector.classList.add('open');
  ui.inspector.setAttribute('aria-hidden', 'false');
  refreshInspector(nodeId);
}

function refreshInspector(nodeId) {
  const node = parsed?.nodes?.find((n) => n.id === nodeId);
  if (!node) return;
  ui.inspectorTitle.textContent = `Строка ${node.line} · ${node.kind}`;
  ui.inspectorCode.textContent = node.code;
  const state = lastNodeState.get(nodeId);
  if (state && Object.keys(state).length) {
    ui.inspectorState.className = 'kv-list';
    ui.inspectorState.innerHTML = Object.entries(state).map(([k, v]) => `<div class="kv-row"><strong>${escapeHtml(k)}</strong> = ${escapeHtml(safeText(v))}</div>`).join('');
  } else {
    ui.inspectorState.className = 'kv-list muted'; ui.inspectorState.textContent = 'Нода ещё не меняла состояние данных.';
  }
  const history = nodeHistory.get(nodeId) ?? [];
  if (history.length) {
    ui.inspectorHistory.className = 'history-list';
    ui.inspectorHistory.innerHTML = history.slice().reverse().map((h) => `<div class="history-row">#${h.time} · ${escapeHtml(h.label)}</div>`).join('');
  } else {
    ui.inspectorHistory.className = 'history-list muted'; ui.inspectorHistory.textContent = 'Пока пусто.';
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>'"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c]));
}

async function parseEditorCode() {
  if (!parseProgram) return;
  const version = ++parseVersion;
  isRunning = false;
  const source = editor.getValue();
  let result;
  try {
    const raw = parseProgram(source);
    result = JSON.parse(String(raw));
  } catch (error) {
    result = { ok: false, error: `Ошибка парсера: ${error.message}` };
  }
  if (version !== parseVersion) return;
  parsed = result;
  editor.session.clearAnnotations();

  if (!result.ok) {
    ui.parseBadge.textContent = result.error || 'Ошибка';
    ui.parseBadge.className = 'mini-badge bad';
    if (result.line) editor.session.setAnnotations([{ row: result.line - 1, column: Math.max(0, (result.offset ?? 1) - 1), text: result.error, type: 'error' }]);
    renderGraph(null);
    iterator = null; currentLineEvent = null;
    setControls(false);
    return;
  }

  ui.parseBadge.textContent = `${result.nodes.length} нод`;
  ui.parseBadge.className = 'mini-badge ok';
  ui.jumpLine.max = Math.max(1, source.split('\n').length);
  renderGraph(result);
  await resetRuntime({ clear: false, prime: true });
}

async function init() {
  try {
    setEngineStatus('Загрузка Python…', 'loading');
    pyodide = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v314.0.6/full/' });
    const engineSource = await fetch('engine.py').then((r) => {
      if (!r.ok) throw new Error(`engine.py: HTTP ${r.status}`);
      return r.text();
    });
    pyodide.runPython(engineSource);
    parseProgram = pyodide.globals.get('parse_program');
    setEngineStatus('Python готов', 'ready');
    clearConsole('Python загружен. Ноды формируются до запуска программы.');
    await parseEditorCode();
  } catch (error) {
    setEngineStatus('Ошибка загрузки', 'error');
    addConsole(`Не удалось запустить Pyodide: ${error.message}. Откройте проект через HTTP-сервер, а не file://.`, 'console-error');
  }
}

editor.session.on('change', () => {
  pauseRun();
  iterator = null;
  currentLineEvent = null;
  waitingForInput = false;
  resumeRunAfterInput = false;
  ui.inputForm.classList.add('hidden');
  setControls(false);
  clearTimeout(parseTimer);
  parseTimer = setTimeout(parseEditorCode, 420);
});

ui.runBtn.addEventListener('click', () => {
  if (ui.runBtn.textContent.includes('Снова')) resetRuntime({ clear: true, prime: true }).then(runLoop);
  else runLoop();
});
ui.stepBtn.addEventListener('click', stepOnce);
ui.pauseBtn.addEventListener('click', pauseRun);
ui.resetBtn.addEventListener('click', () => resetRuntime({ clear: true, prime: true }));
ui.jumpBtn.addEventListener('click', () => jumpToLine(ui.jumpLine.value));
ui.speedRange.addEventListener('input', () => ui.speedLabel.textContent = `${(Number(ui.speedRange.value) / 1000).toFixed(1)} с`);
ui.clearConsoleBtn.addEventListener('click', () => clearConsole('Консоль очищена.'));
ui.helpBtn.addEventListener('click', () => ui.helpDialog.showModal());
ui.closeInspector.addEventListener('click', () => { ui.inspector.classList.remove('open'); ui.inspector.setAttribute('aria-hidden','true'); selectedNodeId = null; });

function installSplitter(splitter, orientation) {
  let active = false;
  const apply = (event) => {
    if (!active) return;
    if (orientation === 'vertical') {
      const rect = ui.workspace.getBoundingClientRect();
      const percent = Math.max(24, Math.min(72, ((event.clientX - rect.left) / rect.width) * 100));
      ui.appShell.style.setProperty('--editor-ratio', `${percent}%`);
    } else {
      const rect = ui.appShell.getBoundingClientRect();
      const height = Math.max(120, Math.min(rect.height * .62, rect.bottom - event.clientY - 18));
      ui.appShell.style.setProperty('--console-height', `${height}px`);
    }
    editor.resize();
  };
  splitter.addEventListener('pointerdown', (event) => {
    active = true;
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add('dragging');
    document.body.classList.add('is-resizing');
    document.body.classList.toggle('horizontal', orientation === 'horizontal');
    event.preventDefault();
  });
  splitter.addEventListener('pointermove', apply);
  const finish = (event) => {
    if (!active) return;
    active = false;
    splitter.releasePointerCapture(event.pointerId);
    splitter.classList.remove('dragging');
    document.body.classList.remove('is-resizing', 'horizontal');
  };
  splitter.addEventListener('pointerup', finish);
  splitter.addEventListener('pointercancel', finish);
  splitter.addEventListener('keydown', (event) => {
    const key = orientation === 'vertical' ? (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0) : (event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0);
    if (!key) return;
    const prop = orientation === 'vertical' ? '--editor-ratio' : '--console-height';
    const current = parseFloat(getComputedStyle(ui.appShell).getPropertyValue(prop));
    const step = orientation === 'vertical' ? 2 : 20;
    ui.appShell.style.setProperty(prop, `${current + key * step}${orientation === 'vertical' ? '%' : 'px'}`);
    editor.resize();
    event.preventDefault();
  });
}

installSplitter(ui.workspaceSplitter, 'vertical');
installSplitter(ui.consoleSplitter, 'horizontal');

document.querySelectorAll('.panel-expand').forEach((button) => {
  button.addEventListener('click', () => {
    const panel = button.closest('.panel, .console-panel');
    const opening = !panel.classList.contains('is-fullscreen');
    document.querySelectorAll('.is-fullscreen').forEach((item) => item.classList.remove('is-fullscreen'));
    panel.classList.toggle('is-fullscreen', opening);
    button.textContent = opening ? '×' : '⛶';
    button.setAttribute('aria-label', opening ? 'Выйти из полноэкранного режима' : 'Развернуть окно');
    requestAnimationFrame(() => editor.resize());
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const panel = document.querySelector('.is-fullscreen');
  if (!panel) return;
  panel.classList.remove('is-fullscreen');
  const button = panel.querySelector('.panel-expand');
  button.textContent = '⛶';
  button.setAttribute('aria-label', 'Развернуть окно');
  requestAnimationFrame(() => editor.resize());
});

ui.inputForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!waitingForInput) return;
  const value = ui.inputField.value;
  addConsole(`${ui.inputPrompt.textContent} ${value}`, 'console-input-echo');
  waitingForInput = false;
  ui.inputForm.classList.add('hidden');
  const shouldResume = resumeRunAfterInput;
  resumeRunAfterInput = false;
  const state = await pumpToNextPause(value);
  if (shouldResume && state === 'line') runLoop();
  else setControls(Boolean(parsed?.ok));
});
