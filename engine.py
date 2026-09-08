import ast
import json

SUPPORTED_STMTS = {
    "Assign", "AugAssign", "Expr", "If", "While", "For", "FunctionDef",
    "Return", "Pass", "Break", "Continue",
}

SUPPORTED_EXPRS = {
    "Constant", "Name", "BinOp", "UnaryOp", "BoolOp", "Compare", "Call",
    "List", "Tuple", "Dict", "Subscript", "Slice", "IfExp", "Attribute",
}

OP_NAMES = {
    ast.Add: "Add", ast.Sub: "Sub", ast.Mult: "Mult", ast.Div: "Div",
    ast.FloorDiv: "FloorDiv", ast.Mod: "Mod", ast.Pow: "Pow",
    ast.Eq: "Eq", ast.NotEq: "NotEq", ast.Lt: "Lt", ast.LtE: "LtE",
    ast.Gt: "Gt", ast.GtE: "GtE", ast.In: "In", ast.NotIn: "NotIn",
    ast.Is: "Is", ast.IsNot: "IsNot", ast.And: "And", ast.Or: "Or",
    ast.Not: "Not", ast.USub: "USub", ast.UAdd: "UAdd",
}


def _op_name(node):
    return OP_NAMES.get(type(node), type(node).__name__)


def _short_label(node, source_lines):
    line = source_lines[node.lineno - 1].strip() if getattr(node, "lineno", None) else type(node).__name__
    if isinstance(node, ast.FunctionDef):
        return f"def {node.name}(…)"
    if isinstance(node, ast.If):
        return "if …"
    if isinstance(node, ast.While):
        return "while …"
    if isinstance(node, ast.For):
        return "for …"
    if isinstance(node, ast.Return):
        return "return …" if node.value else "return"
    return line if len(line) <= 34 else line[:31] + "…"


def _node_kind(node):
    if isinstance(node, ast.FunctionDef): return "function"
    if isinstance(node, ast.If): return "condition"
    if isinstance(node, (ast.While, ast.For)): return "loop"
    if isinstance(node, ast.Return): return "return"
    if isinstance(node, ast.Assign): return "assign"
    if isinstance(node, ast.AugAssign): return "assign"
    if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
        if isinstance(node.value.func, ast.Name) and node.value.func.id == "print":
            return "output"
        return "call"
    return "statement"


def _expr(node):
    if node is None:
        return None
    t = type(node).__name__
    if t not in SUPPORTED_EXPRS:
        raise ValueError(f"Выражение {t} пока не поддерживается")

    base = {"type": t, "line": getattr(node, "lineno", None)}
    if isinstance(node, ast.Constant):
        base["value"] = node.value
    elif isinstance(node, ast.Name):
        base["id"] = node.id
    elif isinstance(node, ast.BinOp):
        base.update(left=_expr(node.left), op=_op_name(node.op), right=_expr(node.right))
    elif isinstance(node, ast.UnaryOp):
        base.update(op=_op_name(node.op), operand=_expr(node.operand))
    elif isinstance(node, ast.BoolOp):
        base.update(op=_op_name(node.op), values=[_expr(v) for v in node.values])
    elif isinstance(node, ast.Compare):
        base.update(left=_expr(node.left), ops=[_op_name(o) for o in node.ops], comparators=[_expr(v) for v in node.comparators])
    elif isinstance(node, ast.Call):
        if node.keywords:
            raise ValueError("Именованные аргументы пока не поддерживаются — используйте позиционные")
        base.update(func=_expr(node.func), args=[_expr(a) for a in node.args], keywords=[])
    elif isinstance(node, (ast.List, ast.Tuple)):
        base["elts"] = [_expr(v) for v in node.elts]
    elif isinstance(node, ast.Dict):
        base.update(keys=[_expr(k) for k in node.keys], values=[_expr(v) for v in node.values])
    elif isinstance(node, ast.Subscript):
        base.update(value=_expr(node.value), slice=_expr(node.slice))
    elif isinstance(node, ast.Slice):
        base.update(lower=_expr(node.lower), upper=_expr(node.upper), step=_expr(node.step))
    elif isinstance(node, ast.IfExp):
        base.update(test=_expr(node.test), body=_expr(node.body), orelse=_expr(node.orelse))
    elif isinstance(node, ast.Attribute):
        base.update(value=_expr(node.value), attr=node.attr)
    return base


def _target(node):
    if isinstance(node, ast.Name):
        return {"type": "Name", "id": node.id, "line": getattr(node, "lineno", None)}
    if isinstance(node, ast.Subscript):
        return {"type": "Subscript", "value": _expr(node.value), "slice": _expr(node.slice), "line": getattr(node, "lineno", None)}
    raise ValueError("Поддерживаются присваивания только переменным и элементам списка/словаря")


def _stmt(node, source_lines, counter, depth=0, scope="module"):
    t = type(node).__name__
    if t not in SUPPORTED_STMTS:
        raise ValueError(f"Конструкция {t} пока не поддерживается")

    counter[0] += 1
    node_id = f"n{counter[0]}"
    code = ast.get_source_segment("\n".join(source_lines), node) or source_lines[node.lineno - 1].strip()
    base = {
        "type": t,
        "id": node_id,
        "line": node.lineno,
        "endLine": getattr(node, "end_lineno", node.lineno),
        "depth": depth,
        "scope": scope,
        "code": code,
        "label": _short_label(node, source_lines),
        "kind": _node_kind(node),
    }

    if isinstance(node, ast.Assign):
        if len(node.targets) != 1:
            raise ValueError("Цепочки присваиваний вроде a = b = 1 пока не поддерживаются")
        base.update(target=_target(node.targets[0]), value=_expr(node.value))
    elif isinstance(node, ast.AugAssign):
        base.update(target=_target(node.target), op=_op_name(node.op), value=_expr(node.value))
    elif isinstance(node, ast.Expr):
        base["value"] = _expr(node.value)
    elif isinstance(node, ast.If):
        base.update(
            test=_expr(node.test),
            body=[_stmt(s, source_lines, counter, depth + 1, scope) for s in node.body],
            orelse=[_stmt(s, source_lines, counter, depth + 1, scope) for s in node.orelse],
        )
    elif isinstance(node, ast.While):
        base.update(test=_expr(node.test), body=[_stmt(s, source_lines, counter, depth + 1, scope) for s in node.body])
    elif isinstance(node, ast.For):
        base.update(target=_target(node.target), iter=_expr(node.iter), body=[_stmt(s, source_lines, counter, depth + 1, scope) for s in node.body])
    elif isinstance(node, ast.FunctionDef):
        if node.args.vararg or node.args.kwarg or node.args.kwonlyargs or node.args.posonlyargs:
            raise ValueError("Поддерживаются функции только с обычными позиционными аргументами")
        fn_scope = node.name
        args = [a.arg for a in node.args.args]
        defaults = [_expr(d) for d in node.args.defaults]
        base.update(
            name=node.name,
            args=args,
            defaults=defaults,
            body=[_stmt(s, source_lines, counter, depth + 1, fn_scope) for s in node.body],
        )
    elif isinstance(node, ast.Return):
        base["value"] = _expr(node.value)
    return base


def _flatten(stmts):
    out = []
    for s in stmts:
        out.append({k: s[k] for k in ("id", "line", "endLine", "depth", "scope", "code", "label", "kind", "type")})
        for key in ("body", "orelse"):
            if key in s:
                out.extend(_flatten(s[key]))
    return out


def parse_program(source):
    if not source.strip():
        return json.dumps({"ok": True, "program": [], "nodes": [], "warnings": []}, ensure_ascii=False)
    try:
        tree = ast.parse(source)
        lines = source.splitlines()
        counter = [0]
        program = [_stmt(s, lines, counter) for s in tree.body]
        return json.dumps({"ok": True, "program": program, "nodes": _flatten(program), "warnings": []}, ensure_ascii=False)
    except SyntaxError as e:
        return json.dumps({
            "ok": False,
            "error": f"SyntaxError: {e.msg}",
            "line": e.lineno,
            "offset": e.offset,
        }, ensure_ascii=False)
    except ValueError as e:
        return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)
