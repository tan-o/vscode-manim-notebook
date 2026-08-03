export interface TypstMathContext {
  display: boolean;
  contentStart: number;
  contentEnd: number;
}

export interface TypstMathSpan {
  expression: string;
  display: boolean;
  start: number;
  end: number;
}

export interface TypstMathWord {
  prefix: string;
  start: number;
  end: number;
}

export interface TypstMathCompletion {
  label: string;
  glyph: string;
  detail: string;
  insertText: string;
  aliases: readonly string[];
  snippet?: boolean;
}

function escaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function markdownCodeMask(source: string): Uint8Array {
  const mask = new Uint8Array(source.length);
  let fence: { marker: string; width: number } | undefined;
  let lineStart = 0;
  while (lineStart < source.length) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? source.length : newline + 1;
    const line = source.slice(lineStart, newline < 0 ? source.length : newline);
    const candidate = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const closes = Boolean(
      fence && candidate && candidate[0] === fence.marker && candidate.length >= fence.width,
    );
    if (fence || candidate) {
      mask.fill(1, lineStart, lineEnd);
    }
    if (closes) {
      fence = undefined;
    } else if (!fence && candidate) {
      fence = { marker: candidate[0], width: candidate.length };
    }
    lineStart = lineEnd;
  }

  // Markdown code spans can use any run length of backticks.  Mark only a
  // same-line matching pair; an unmatched opening tick remains normal text.
  for (let index = 0; index < source.length; index += 1) {
    if (mask[index] || source[index] !== "`") continue;
    let width = 1;
    while (source[index + width] === "`") width += 1;
    const marker = "`".repeat(width);
    const lineEnd = source.indexOf("\n", index + width);
    const close = source.indexOf(marker, index + width);
    if (close >= 0 && (lineEnd < 0 || close < lineEnd)) {
      mask.fill(1, index, close + width);
      index = close + width - 1;
    } else {
      index += width - 1;
    }
  }
  return mask;
}

/** Return closed dollar-delimited Typst formulas outside Markdown code. */
export function typstMathSpans(source: string): TypstMathSpan[] {
  const mask = markdownCodeMask(source);
  const spans: TypstMathSpan[] = [];
  for (let start = 0; start < source.length; start += 1) {
    if (mask[start] || source[start] !== "$" || escaped(source, start)) continue;
    const display = source[start + 1] === "$" && !mask[start + 1];
    const width = display ? 2 : 1;
    let close = start + width;
    for (; close < source.length; close += 1) {
      if (!display && source[close] === "\n") break;
      if (mask[close] || source[close] !== "$" || escaped(source, close)) continue;
      if (display) {
        if (source[close + 1] !== "$" || mask[close + 1]) continue;
      } else if (source[close + 1] === "$" || source[close - 1] === "$") {
        continue;
      }
      const expression = source.slice(start + width, close).trim();
      if (expression) {
        spans.push({ expression, display, start, end: close + width });
      }
      start = close + width - 1;
      break;
    }
  }
  return spans;
}

/** Locate the Typst expression that owns a Markdown cursor, including while it is still unclosed. */
export function typstMathContextAtOffset(
  source: string,
  requestedOffset: number,
): TypstMathContext | undefined {
  const offset = Math.max(0, Math.min(requestedOffset, source.length));
  const mask = markdownCodeMask(source);
  let active: { delimiter: "$" | "$$"; contentStart: number } | undefined;
  for (let index = 0; index < source.length; index += 1) {
    if (mask[index] || source[index] !== "$" || escaped(source, index)) continue;
    const delimiter: "$" | "$$" = source[index + 1] === "$" ? "$$" : "$";
    const width = delimiter.length;
    if (!active) {
      active = { delimiter, contentStart: index + width };
      index += width - 1;
      continue;
    }
    if (delimiter !== active.delimiter) {
      index += width - 1;
      continue;
    }
    if (offset >= active.contentStart && offset <= index) {
      return {
        display: delimiter === "$$",
        contentStart: active.contentStart,
        contentEnd: index,
      };
    }
    active = undefined;
    index += width - 1;
  }
  if (active && offset >= active.contentStart) {
    return {
      display: active.delimiter === "$$",
      contentStart: active.contentStart,
      contentEnd: source.length,
    };
  }
  return undefined;
}

export function typstMathWordAtOffset(
  source: string,
  offset: number,
): TypstMathWord | undefined {
  const context = typstMathContextAtOffset(source, offset);
  if (!context) return undefined;
  return typstMathWordInContext(source, offset, context.contentStart, context.contentEnd);
}

/**
 * Locate the Typst expression argument of `TypstMath("...")` in a Python /
 * Manim cell, including while it is still unclosed.
 */
export function typstMathPythonContextAtOffset(
  source: string,
  requestedOffset: number,
): TypstMathContext | undefined {
  const offset = Math.max(0, Math.min(requestedOffset, source.length));
  const pattern = /\bTypstMath\s*\(/g;
  let call: RegExpExecArray | null;
  while ((call = pattern.exec(source)) !== null) {
    let cursor = call.index + call[0].length;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if ((source[cursor] === "r" || source[cursor] === "R") &&
        (source[cursor + 1] === '"' || source[cursor + 1] === "'")) {
      cursor += 1;
    }
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") continue;
    const contentStart = cursor + 1;
    let contentEnd = contentStart;
    while (contentEnd < source.length) {
      if (source[contentEnd] === "\\") {
        contentEnd += 2;
        continue;
      }
      if (source[contentEnd] === quote) break;
      contentEnd += 1;
    }
    if (offset >= contentStart && offset <= contentEnd) {
      return {
        display: false,
        contentStart,
        contentEnd: contentEnd < source.length ? contentEnd : source.length,
      };
    }
  }
  return undefined;
}

export function typstMathPythonWordAtOffset(
  source: string,
  offset: number,
): TypstMathWord | undefined {
  const context = typstMathPythonContextAtOffset(source, offset);
  if (!context) return undefined;
  return typstMathWordInContext(source, offset, context.contentStart, context.contentEnd);
}

function typstMathWordInContext(
  source: string,
  offset: number,
  contentStart: number,
  contentEnd: number,
): TypstMathWord | undefined {
  let start = Math.max(contentStart, Math.min(offset, source.length));
  let end = start;
  while (start > contentStart && /[A-Za-z0-9_.]/.test(source[start - 1])) start -= 1;
  while (end < contentEnd && /[A-Za-z0-9_.]/.test(source[end])) end += 1;
  return { prefix: source.slice(start, offset), start, end };
}

const greekLower: ReadonlyArray<readonly [string, string]> = [
  ["alpha", "α"], ["beta", "β"], ["gamma", "γ"], ["delta", "δ"],
  ["epsilon", "ε"], ["zeta", "ζ"], ["eta", "η"], ["theta", "θ"],
  ["iota", "ι"], ["kappa", "κ"], ["lambda", "λ"], ["mu", "μ"],
  ["nu", "ν"], ["xi", "ξ"], ["omicron", "ο"], ["pi", "π"],
  ["rho", "ρ"], ["sigma", "σ"], ["tau", "τ"], ["upsilon", "υ"],
  ["phi", "φ"], ["chi", "χ"], ["psi", "ψ"], ["omega", "ω"],
];

const greekUpper: ReadonlyArray<readonly [string, string]> = [
  ["Alpha", "Α"], ["Beta", "Β"], ["Gamma", "Γ"], ["Delta", "Δ"],
  ["Epsilon", "Ε"], ["Zeta", "Ζ"], ["Eta", "Η"], ["Theta", "Θ"],
  ["Iota", "Ι"], ["Kappa", "Κ"], ["Lambda", "Λ"], ["Mu", "Μ"],
  ["Nu", "Ν"], ["Xi", "Ξ"], ["Omicron", "Ο"], ["Pi", "Π"],
  ["Rho", "Ρ"], ["Sigma", "Σ"], ["Tau", "Τ"], ["Upsilon", "Υ"],
  ["Phi", "Φ"], ["Chi", "Χ"], ["Psi", "Ψ"], ["Omega", "Ω"],
];

function symbol(
  label: string,
  glyph: string,
  detail: string,
  aliases: readonly string[] = [],
): TypstMathCompletion {
  return { label, glyph, detail, insertText: label, aliases };
}

function template(
  label: string,
  glyph: string,
  detail: string,
  insertText: string,
  aliases: readonly string[],
): TypstMathCompletion {
  return { label, glyph, detail, insertText, aliases, snippet: true };
}

/** Offline catalog derived from Typst's built-in math names and functions. */
export const TYPST_MATH_COMPLETIONS: readonly TypstMathCompletion[] = [
  ...greekLower.map(([label, glyph]) => symbol(label, glyph, "希腊小写字母")),
  ...greekUpper.map(([label, glyph]) => symbol(label, glyph, "希腊大写字母")),
  symbol("integral", "∫", "积分符号", ["int", "integrate", "积分"]),
  template("integral.bounds", "∫", "定积分模板", 'integral_${1:a}^${2:b} ${3:f(x)} dif ${4:x}', ["int", "definite", "定积分"]),
  symbol("integral.double", "∬", "二重积分", ["iint", "double integral"]),
  symbol("integral.triple", "∭", "三重积分", ["iiint", "triple integral"]),
  symbol("integral.cont", "∮", "曲线积分", ["oint", "contour integral"]),
  symbol("sum", "∑", "求和符号", ["sigma", "求和"]),
  template("sum.bounds", "∑", "带上下限的求和模板", 'sum_(${1:k=1})^${2:n} ${3:a_k}', ["sum", "summation", "求和"]),
  symbol("product", "∏", "连乘符号", ["prod", "product", "连乘"]),
  template("product.bounds", "∏", "带上下限的连乘模板", 'product_(${1:k=1})^${2:n} ${3:a_k}', ["prod", "product", "连乘"]),
  symbol("dif", "d", "积分微分符号", ["dx", "differential", "微分"]),
  symbol("partial", "∂", "偏微分", ["pd", "partial derivative", "偏导"]),
  symbol("nabla", "∇", "Nabla / 梯度算子", ["grad", "gradient"]),
  symbol("infinity", "∞", "无穷", ["inf", "oo", "infinite"]),
  template("frac", "a/b", "分式", 'frac(${1:a}, ${2:b})', ["fraction", "divide", "分式"]),
  template("sqrt", "√", "平方根", 'sqrt(${1:x})', ["root", "square root", "根号"]),
  template("root", "ⁿ√", "n 次根", 'root(${1:n}, ${2:x})', ["nth root", "根式"]),
  template("lim", "lim", "极限", 'lim_(${1:x -> infinity}) ${2:f(x)}', ["limit", "极限"]),
  template("cases", "{", "分段表达式", 'cases(${1:f(x)} & ${2:x >= 0}, ${3:g(x)} & ${4:x < 0})', ["piecewise", "分段"]),
  template("mat", "▦", "矩阵", 'mat(${1:a}, ${2:b}; ${3:c}, ${4:d})', ["matrix", "矩阵"]),
  template("vec", "⃗", "列向量", 'vec(${1:x}, ${2:y})', ["vector", "向量"]),
  template("binom", "()", "二项式系数", 'binom(${1:n}, ${2:k})', ["choose", "combination", "二项式"]),
  template("abs", "|x|", "绝对值", 'abs(${1:x})', ["absolute", "绝对值"]),
  template("norm", "‖x‖", "范数", 'norm(${1:x})', ["magnitude", "范数"]),
  symbol("plus.minus", "±", "正负号", ["pm", "plusminus"]),
  symbol("minus.plus", "∓", "负正号", ["mp", "minusplus"]),
  symbol("times", "×", "乘号", ["multiply"]),
  symbol("dot", "·", "点乘", ["cdot"]),
  symbol("dot.op", "∘", "复合 / 函数复合", ["comp", "composition", "复合"]),
  symbol("eq.not", "≠", "不等于", ["neq", "!="]),
  symbol("approx", "≈", "约等于", ["approximately"]),
  symbol("equiv", "≡", "恒等 / 等价", ["equivalent"]),
  symbol("lt.eq", "≤", "小于等于", ["le", "<="]),
  symbol("gt.eq", "≥", "大于等于", ["ge", ">="]),
  symbol("in", "∈", "属于", ["element"]),
  symbol("in.not", "∉", "不属于", ["notin"]),
  symbol("subset", "⊂", "真子集", ["sub"]),
  symbol("subset.eq", "⊆", "子集或相等", ["subseteq"]),
  symbol("supset", "⊃", "真超集", ["superset"]),
  symbol("supset.eq", "⊇", "超集或相等", ["superseteq"]),
  symbol("parallel", "∥", "平行", ["parallel to"]),
  symbol("perp", "⊥", "垂直", ["perpendicular"]),
  symbol("union", "∪", "并集", ["cup"]),
  symbol("inter", "∩", "交集", ["intersection", "cap"]),
  symbol("and", "∧", "逻辑与", ["land", "wedge"]),
  symbol("or", "∨", "逻辑或", ["lor", "vee"]),
  symbol("not", "¬", "逻辑非", ["neg", "lnot"]),
  symbol("emptyset", "∅", "空集", ["empty", "nothing"]),
  symbol("forall", "∀", "任意 / 对所有", ["all"]),
  symbol("exists", "∃", "存在", ["exist"]),
  symbol("arrow.r", "→", "右箭头", ["right arrow", "->"]),
  symbol("arrow.l", "←", "左箭头", ["left arrow", "<-"]),
  symbol("arrow.l.r", "↔", "双向箭头", ["leftright", "<->"]),
  symbol("arrow.t", "↑", "上箭头", ["up arrow"]),
  symbol("arrow.b", "↓", "下箭头", ["down arrow"]),
  symbol("arrow.l.double", "⇐", "左双箭头", ["double left arrow"]),
  symbol("arrow.r.double", "⇒", "右双箭头 / 推出", ["implies", "=>"]),
  symbol("arrow.l.r.double", "⇔", "双向双箭头 / 等价", ["iff", "<=>"]),
  symbol("arrow.long.r", "⟶", "长右箭头", ["longrightarrow", "long right arrow"]),
  symbol("Delta", "∆", "增量 / 拉普拉斯算子", ["increment", "laplacian", "增量"]),
  symbol("NN", "ℕ", "自然数集", ["natural numbers"]),
  symbol("ZZ", "ℤ", "整数集", ["integers"]),
  symbol("QQ", "ℚ", "有理数集", ["rationals"]),
  symbol("RR", "ℝ", "实数集", ["reals"]),
  symbol("CC", "ℂ", "复数集", ["complex numbers"]),
  symbol("epsilon.alt", "ϵ", "希腊小写字母变体（lunate epsilon）", ["epsilon variant"]),
  symbol("theta.alt", "ϑ", "希腊小写字母变体（theta symbol）", ["theta variant"]),
  symbol("pi.alt", "ϖ", "希腊小写字母变体（varpi）", ["pi variant"]),
  symbol("rho.alt", "ϱ", "希腊小写字母变体（varrho）", ["rho variant"]),
  symbol("phi.alt", "ϕ", "希腊小写字母变体（phi symbol）", ["phi variant"]),
];

const TYPST_MATH_WORDS = new Set<string>([
  ...TYPST_MATH_COMPLETIONS.flatMap((item) => item.label.split(".")),
  "accent", "attach", "binom", "cancel", "cases", "class", "dif", "display",
  "floor", "ceil", "frac", "limits", "lr", "mat", "mid", "op", "overline",
  "root", "sqrt", "stretch", "underbrace", "underline", "upright", "vec",
  "sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh",
  "arcsin", "arccos", "arctan", "log", "ln", "exp", "lim", "min", "max",
]);

/**
 * Typst treats an unknown multi-letter run as one variable. For conventional
 * handwritten input such as `E=mc^2`, split only unknown ASCII runs into
 * implicit multiplication while preserving Typst's built-in math names.
 */
export function normalizeTypstMathExpression(expression: string): string {
  return expression
    .split(/("(?:\\.|[^"\\])*")/g)
    .map((part, index) => index % 2 === 1
      ? part
      : part.replace(/[A-Za-z]{2,}/g, (word, offset, source) => {
          if (source[offset - 1] === "#" || TYPST_MATH_WORDS.has(word)) return word;
          return [...word].join(" ");
        }))
    .join("");
}

function matchScore(item: TypstMathCompletion, prefix: string): number | undefined {
  const query = prefix.toLowerCase();
  if (!query) return item.snippet ? 2 : 3;
  const values = [item.label, ...item.aliases].map((value) => value.toLowerCase());
  if (values[0] === query) return 0;
  if (values.some((value) => value === query)) return 1;
  if (values[0].startsWith(query)) return 2;
  if (values.some((value) => value.startsWith(query))) return 3;
  if (values.some((value) => value.includes(query))) return 4;
  return undefined;
}

export function typstMathSuggestions(
  prefix: string,
  limit = 40,
): TypstMathCompletion[] {
  return TYPST_MATH_COMPLETIONS
    .map((item, index) => ({ item, index, score: matchScore(item, prefix) }))
    .filter((entry): entry is { item: TypstMathCompletion; index: number; score: number } =>
      entry.score !== undefined)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}
