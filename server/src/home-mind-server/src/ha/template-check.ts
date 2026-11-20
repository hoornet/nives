/**
 * Which Jinja templates an automation written by the assistant may contain.
 *
 * A template runs later with Home Assistant's own authority and can read any
 * entity in the house. Looking for dangerous patterns cannot keep up with what
 * Jinja can express, so this is an allowlist of shapes instead, parsed rather
 * than matched: a device can only be read by naming it, and the name is then
 * held to the exposure list like any other mention.
 *
 * Allowed inside `{{ ... }}`:
 * - `states('<id>')`, `state_translated('<id>')`, `has_value('<id>')`,
 *   `state_attr('<id>', '<attribute>')`, `is_state('<id>', <value>)`,
 *   `is_state_attr('<id>', '<attribute>', <value>)`, with `<id>` a literal
 *   entity id or `trigger.entity_id`;
 * - `states.<domain>.<object>` followed by `.state`, `.name`, `.last_changed`,
 *   `.last_updated` or `.attributes.<name>`;
 * - what the trigger carries (`trigger.to_state.state`, `trigger.entity_id`,
 *   ...), the loop counter (`repeat.index`) and the automation's own entity
 *   (`this.state`);
 * - `now()`, `utcnow()`, `today_at('<time>')` and their date parts,
 *   `as_timestamp(...)`;
 * - numbers, quoted text, `true` / `false` / `none`, arithmetic, `~`,
 *   comparisons, `and` / `or` / `not`, `a if b else c`, parentheses;
 * - the filters in `FILTERS`.
 *
 * Everything else is refused, `{% ... %}` statements included.
 */

const FILTERS: ReadonlySet<string> = new Set([
  "float",
  "int",
  "round",
  "default",
  "lower",
  "upper",
  "title",
  "capitalize",
  "string",
  "abs",
  "trim",
  "timestamp_custom",
  "timestamp_local",
]);

/** Functions that take an entity id first. */
const ENTITY_FUNCTIONS: ReadonlySet<string> = new Set([
  "states",
  "state_translated",
  "has_value",
  "state_attr",
  "is_state",
  "is_state_attr",
]);

/** Names whose attributes may be read: what the trigger, a repeat and the automation itself carry. */
const CONTEXT_NAMES: ReadonlySet<string> = new Set(["trigger", "repeat", "this", "wait"]);

/** Parts of a date the template may read or format. */
const DATE_PARTS: ReadonlySet<string> = new Set([
  "strftime",
  "hour",
  "minute",
  "second",
  "day",
  "month",
  "year",
  "weekday",
  "isoweekday",
  "date",
  "time",
  "timestamp",
]);

const STATE_FIELDS: ReadonlySet<string> = new Set([
  "state",
  "name",
  "last_changed",
  "last_updated",
  "attributes",
]);

const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;

type Token = { kind: "num" | "str" | "name" | "op"; text: string };

function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let text = "";
      while (j < source.length && source[j] !== c) {
        if (source[j] === "\\") return null; // escapes are not needed in what the assistant writes
        text += source[j++];
      }
      if (j >= source.length) return null;
      tokens.push({ kind: "str", text });
      i = j + 1;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(source.slice(i));
    if (num) {
      tokens.push({ kind: "num", text: num[0] });
      i += num[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (name) {
      tokens.push({ kind: "name", text: name[0] });
      i += name[0].length;
      continue;
    }
    const op = /^(==|!=|<=|>=|\/\/|[<>+\-*/%~|(),.])/.exec(source.slice(i));
    if (!op) return null;
    tokens.push({ kind: "op", text: op[0] });
    i += op[0].length;
  }
  return tokens;
}

/** A recursive-descent check of one `{{ ... }}` expression; any throw means "not allowed". */
class Checker {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  check(): boolean {
    try {
      this.expression();
      return this.pos === this.tokens.length;
    } catch {
      return false;
    }
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private isOp(text: string): boolean {
    const t = this.peek();
    return t?.kind === "op" && t.text === text;
  }

  private isName(text: string): boolean {
    const t = this.peek();
    return t?.kind === "name" && t.text === text;
  }

  private take(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw new Error("end");
    return t;
  }

  private expect(text: string): void {
    const t = this.take();
    if (t.text !== text) throw new Error(`expected ${text}`);
  }

  private name(): string {
    const t = this.take();
    if (t.kind !== "name") throw new Error("expected a name");
    return t.text;
  }

  private expression(): void {
    this.or();
    if (this.isName("if")) {
      this.take();
      this.or();
      this.expect("else");
      this.expression();
    }
  }

  private or(): void {
    this.and();
    while (this.isName("or")) {
      this.take();
      this.and();
    }
  }

  private and(): void {
    this.not();
    while (this.isName("and")) {
      this.take();
      this.not();
    }
  }

  private not(): void {
    if (this.isName("not")) {
      this.take();
      this.not();
      return;
    }
    this.comparison();
  }

  private comparison(): void {
    this.sum();
    if (["==", "!=", "<", "<=", ">", ">="].some((op) => this.isOp(op))) {
      this.take();
      this.sum();
    }
  }

  private sum(): void {
    this.product();
    while (["+", "-", "~"].some((op) => this.isOp(op))) {
      this.take();
      this.product();
    }
  }

  private product(): void {
    this.unary();
    while (["*", "/", "//", "%"].some((op) => this.isOp(op))) {
      this.take();
      this.unary();
    }
  }

  private unary(): void {
    if (this.isOp("-")) {
      this.take();
      this.unary();
      return;
    }
    this.filtered();
  }

  private filtered(): void {
    this.primary();
    while (this.isOp("|")) {
      this.take();
      const filter = this.name();
      if (!FILTERS.has(filter)) throw new Error(`filter ${filter}`);
      if (this.isOp("(")) this.literalArguments();
    }
  }

  /** `( literal, literal, ... )`: numbers, text and true/false/none only. */
  private literalArguments(): void {
    this.expect("(");
    if (this.isOp(")")) {
      this.take();
      return;
    }
    for (;;) {
      this.literal();
      if (this.isOp(",")) {
        this.take();
        continue;
      }
      this.expect(")");
      return;
    }
  }

  private literal(): void {
    const t = this.take();
    if (t.kind === "num" || t.kind === "str") return;
    if (t.kind === "name" && /^(true|false|none|True|False|None)$/.test(t.text)) return;
    if (t.kind === "op" && t.text === "-" && this.peek()?.kind === "num") {
      this.take();
      return;
    }
    throw new Error("expected a literal");
  }

  /** A literal entity id, or the entity that fired the (checked) trigger. */
  private entityArgument(): void {
    const t = this.take();
    // Home Assistant lower-cases an id when it looks one up; the exposure
    // check reads the mention lower-cased too.
    if (t.kind === "str" && ENTITY_ID.test(t.text.toLowerCase())) return;
    if (t.kind === "name" && t.text === "trigger" && this.isOp(".")) {
      this.take();
      if (this.name() === "entity_id") return;
    }
    throw new Error("expected an entity id");
  }

  private primary(): void {
    const t = this.peek();
    if (!t) throw new Error("end");
    if (t.kind === "num" || t.kind === "str") {
      this.take();
      return;
    }
    if (t.kind === "op" && t.text === "(") {
      this.take();
      this.expression();
      this.expect(")");
      return;
    }
    if (t.kind !== "name") throw new Error("unexpected token");
    const name = this.name();
    if (/^(true|false|none|True|False|None)$/.test(name)) return;

    if (ENTITY_FUNCTIONS.has(name) && this.isOp("(")) {
      this.take();
      this.entityArgument();
      while (this.isOp(",")) {
        this.take();
        this.literal();
      }
      this.expect(")");
      return;
    }
    if (name === "states" && this.isOp(".")) {
      // states.<domain>.<object>.<field>
      this.take();
      const domain = this.name();
      this.expect(".");
      const object = this.name();
      if (!ENTITY_ID.test(`${domain}.${object}`)) throw new Error("entity id");
      this.expect(".");
      const field = this.name();
      if (!STATE_FIELDS.has(field)) throw new Error(`field ${field}`);
      if (field === "attributes") {
        this.expect(".");
        this.name();
      }
      return;
    }
    if (CONTEXT_NAMES.has(name) && this.isOp(".")) {
      while (this.isOp(".")) {
        this.take();
        this.name();
      }
      return;
    }
    if ((name === "now" || name === "utcnow") && this.isOp("(")) {
      this.expect("(");
      this.expect(")");
      this.dateParts();
      return;
    }
    if (name === "today_at" && this.isOp("(")) {
      this.literalArguments();
      this.dateParts();
      return;
    }
    if (name === "as_timestamp" && this.isOp("(")) {
      this.take();
      this.expression();
      this.expect(")");
      return;
    }
    throw new Error(`name ${name}`);
  }

  private dateParts(): void {
    while (this.isOp(".")) {
      this.take();
      const part = this.name();
      if (!DATE_PARTS.has(part)) throw new Error(`date part ${part}`);
      if (this.isOp("(")) this.literalArguments();
    }
  }
}

/**
 * Whether every template in `text` has one of the allowed shapes. Text with no
 * template is fine; `{% ... %}` statements and anything unparsed are not.
 * Comments (`{# ... #}`) are ignored.
 */
export function isSafeTemplate(text: string): boolean {
  const withoutComments = text.replace(/\{#[\s\S]*?#\}/g, "");
  if (withoutComments.includes("{%") || withoutComments.includes("%}")) return false;
  const blocks = withoutComments.match(/\{\{[\s\S]*?\}\}/g) ?? [];
  const rest = withoutComments.replace(/\{\{[\s\S]*?\}\}/g, "");
  if (rest.includes("{{") || rest.includes("}}")) return false;
  for (const block of blocks) {
    const inner = block.slice(2, -2).replace(/^-/, "").replace(/-$/, "");
    const tokens = tokenize(inner);
    if (!tokens || tokens.length === 0 || !new Checker(tokens).check()) return false;
  }
  return true;
}
