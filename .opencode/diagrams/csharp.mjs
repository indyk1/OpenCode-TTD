// Reads C# source for the /diagram and /classes pages: the namespaces, the types, their members and base types, and
// the type names that member bodies mention. Nothing is compiled. Bodies are skipped apart from the names they use,
// and code the reader cannot follow is skipped too, never reported as an error: this is for drawing diagrams, not
// for checking code. Node built-ins only.

const PUNCT3 = ['??='];
const PUNCT2 = ['=>', '::', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '..'];
const ESCAPES = { n: '\n', r: '\r', t: '\t', 0: '\0', '"': '"', "'": "'", '\\': '\\' };

const TYPE_MODIFIERS = new Set([
  'public', 'private', 'protected', 'internal', 'static', 'sealed', 'abstract', 'partial', 'readonly', 'unsafe', 'new',
  'file', 'virtual', 'override', 'async', 'extern', 'volatile', 'required', 'const', 'fixed', 'implicit', 'explicit',
  'ref', 'scoped',
]);
const PARAMETER_MODIFIERS = new Set(['this', 'ref', 'out', 'in', 'params', 'scoped', 'readonly']);

/** Generic types whose type arguments are held many times over: a property of List<Order> holds many Orders. */
export const COLLECTIONS = new Set([
  'IEnumerable', 'IAsyncEnumerable', 'ICollection', 'IReadOnlyCollection', 'IList', 'IReadOnlyList', 'List', 'Collection',
  'ReadOnlyCollection', 'ObservableCollection', 'LinkedList', 'Queue', 'Stack', 'HashSet', 'ISet', 'IReadOnlySet',
  'SortedSet', 'Dictionary', 'IDictionary', 'IReadOnlyDictionary', 'SortedDictionary', 'SortedList', 'ConcurrentDictionary',
  'ConcurrentBag', 'ConcurrentQueue', 'ImmutableArray', 'ImmutableList', 'ImmutableHashSet', 'ImmutableDictionary',
  'FrozenSet', 'FrozenDictionary', 'IQueryable', 'DbSet', 'Span', 'ReadOnlySpan', 'Memory', 'ReadOnlyMemory',
]);

const isIdStart = (c) => c !== undefined && /[\p{L}\p{Nl}_]/u.test(c);
const isIdPart = (c) => c !== undefined && /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}\p{Cf}]/u.test(c);
const isDigit = (c) => c !== undefined && c >= '0' && c <= '9';

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * Split C# source into tokens: { k: 'id' | 'str' | 'chr' | 'num' | 'p' | 'doc', v, line }. Comments and preprocessor
 * lines are dropped, except `///` documentation comments. A string token's value is its text (interpolation holes
 * become `{…}`); `@name` identifiers carry `verbatim: true`.
 */
export function tokenize(source) {
  return new Lexer(String(source)).run();
}

class Lexer {
  constructor(src) {
    this.s = src;
    this.i = 0;
    this.line = 1;
    this.fresh = true; // nothing but whitespace so far on this line, so `#` starts a preprocessor directive
  }

  run() {
    const tokens = [];
    for (let t = this.next(); t; t = this.next()) tokens.push(t);
    return tokens;
  }

  /** The next token, skipping whitespace, comments and preprocessor lines; null at the end. */
  next() {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '\n') {
        this.line++;
        this.i++;
        this.fresh = true;
      } else if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '﻿' || c === ' ') {
        this.i++;
      } else if (c === '#' && this.fresh) {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
      } else if (c === '/' && s[this.i + 1] === '/') {
        const start = this.i;
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
        const text = s.slice(start, this.i);
        if (text.startsWith('///') && !text.startsWith('////')) {
          this.fresh = false;
          return { k: 'doc', v: text.slice(3).replace(/\r$/, ''), line: this.line };
        }
      } else if (c === '/' && s[this.i + 1] === '*') {
        const end = s.indexOf('*/', this.i + 2);
        const stop = end < 0 ? s.length : end + 2;
        this.countLines(this.i, stop);
        this.i = stop;
      } else {
        this.fresh = false;
        return this.token();
      }
    }
    return null;
  }

  countLines(from, to) {
    for (let j = from; j < to; j++) if (this.s[j] === '\n') this.line++;
  }

  token() {
    const s = this.s;
    const line = this.line;
    const c = s[this.i];
    // Strings, with any $ and @ prefixes: "…", @"…", $"…", $@"…", """…""", $$"""…""".
    let j = this.i;
    let dollars = 0;
    let verbatim = false;
    while ((s[j] === '$' || s[j] === '@') && j - this.i < 8) {
      if (s[j] === '$') dollars++;
      else verbatim = true;
      j++;
    }
    if (s[j] === '"') {
      this.i = j;
      return { k: 'str', v: this.string(dollars, verbatim), line };
    }
    if (c === '@' && isIdStart(s[this.i + 1])) {
      this.i++;
      return { k: 'id', v: this.ident(), line, verbatim: true };
    }
    if (c === "'") return { k: 'chr', v: this.char(), line };
    if (isIdStart(c)) return { k: 'id', v: this.ident(), line };
    if (isDigit(c) || (c === '.' && isDigit(s[this.i + 1]))) {
      const m = /^\.?[0-9][0-9A-Za-z_]*(?:\.[0-9][0-9A-Za-z_]*)?/.exec(s.slice(this.i, this.i + 64));
      this.i += m[0].length;
      return { k: 'num', v: m[0], line };
    }
    for (const p of PUNCT3) {
      if (s.startsWith(p, this.i)) {
        this.i += p.length;
        return { k: 'p', v: p, line };
      }
    }
    for (const p of PUNCT2) {
      if (s.startsWith(p, this.i)) {
        this.i += p.length;
        return { k: 'p', v: p, line };
      }
    }
    this.i++;
    return { k: 'p', v: c, line };
  }

  ident() {
    const start = this.i;
    while (isIdPart(this.s[this.i])) this.i++;
    return this.s.slice(start, this.i);
  }

  char() {
    const s = this.s;
    let j = this.i + 1;
    if (s[j] === '\\') {
      j += 2;
      while (j < s.length && s[j] !== "'" && s[j] !== '\n' && j - this.i < 12) j++;
    } else j++;
    if (s[j] === "'") {
      const v = s.slice(this.i + 1, j);
      this.i = j + 1;
      return v;
    }
    this.i++; // not a character literal after all
    return "'";
  }

  /** At the opening quote. Returns the string's text. */
  string(dollars, verbatim) {
    const s = this.s;
    let quotes = 0;
    while (s[this.i + quotes] === '"') quotes++;
    if (!verbatim && quotes >= 3) {
      // Raw string literal: ends at the same number of quotes. Interpolation holes are left in the text.
      const delimiter = '"'.repeat(quotes);
      const start = this.i + quotes;
      const end = s.indexOf(delimiter, start);
      const stop = end < 0 ? s.length : end;
      this.countLines(start, stop);
      this.i = end < 0 ? s.length : end + quotes;
      return s.slice(start, stop).trim();
    }
    if (!verbatim && quotes === 2) {
      this.i += 2;
      return '';
    }
    this.i++;
    let out = '';
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '"') {
        if (verbatim && s[this.i + 1] === '"') {
          out += '"';
          this.i += 2;
          continue;
        }
        this.i++;
        return out;
      }
      if (c === '\\' && !verbatim) {
        const e = s[this.i + 1];
        if (e === '\n') this.line++;
        out += ESCAPES[e] ?? e ?? '';
        this.i += 2;
        continue;
      }
      if (dollars && c === '{') {
        if (s[this.i + 1] === '{') {
          out += '{';
          this.i += 2;
          continue;
        }
        this.i++;
        this.hole();
        out += '{…}';
        continue;
      }
      if (dollars && c === '}' && s[this.i + 1] === '}') {
        out += '}';
        this.i += 2;
        continue;
      }
      if (c === '\n') {
        if (!verbatim && !dollars) return out; // unterminated: stop at the end of the line
        this.line++;
      }
      out += c;
      this.i++;
    }
    return out;
  }

  /** Skip an interpolation hole, which may hold any expression - strings included - up to its closing brace. */
  hole() {
    let depth = 0;
    for (let t = this.next(); t; t = this.next()) {
      if (t.k !== 'p') continue;
      if (t.v === '{') depth++;
      else if (t.v === '}') {
        if (depth === 0) return;
        depth--;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/**
 * Read the declarations in a C# file. Returns
 *   { usings, globalUsings, aliases, types, statements }
 * - usings / globalUsings: the namespaces imported with `using X.Y;` / `global using X.Y;`
 * - aliases: { Alias: 'Target.Name' } from `using Alias = Target.Name;`
 * - types: one entry per class, struct, interface, enum, record or delegate (nested ones too), each
 *   { name, kind, namespace, parent, path, typeParams, modifiers, visibility, attributes, doc, line,
 *     bases: [TypeRef], parameters: [Parameter] | null (a primary constructor), members: [Member], refs: [string] }
 *   Member: { kind: 'field' | 'property' | 'method' | 'constructor' | 'event' | 'indexer' | 'operator' | 'value',
 *             name, visibility, static, abstract, modifiers, attributes, doc, type: TypeRef | null, params, refs }
 *   TypeRef: { text, name, refs: [{ name, many }] } - `refs` are the type names it is made of, `many` when held in a
 *   collection or array. A member's `refs` are the dotted names starting with a capital letter in its body.
 * - statements: the top-level statements (Program.cs), each as its list of tokens.
 */
export function parseCSharp(source) {
  return new Parser(tokenize(source)).parse();
}

class Parser {
  constructor(tokens) {
    this.t = tokens;
    this.i = 0;
    this.fileNamespace = '';
    this.out = { usings: [], globalUsings: [], aliases: {}, types: [], statements: [] };
  }

  get tok() {
    return this.t[this.i];
  }

  isP(v, o = 0) {
    const x = this.t[this.i + o];
    return x !== undefined && x.k === 'p' && x.v === v;
  }

  /** An identifier - a particular one if `v` is given, which must then not be written as @v. */
  isId(v, o = 0) {
    const x = this.t[this.i + o];
    return x !== undefined && x.k === 'id' && (v === undefined || (x.v === v && !x.verbatim));
  }

  parse() {
    while (this.i < this.t.length) this.members(null, this.fileNamespace);
    return this.out;
  }

  /** Declarations up to the closing brace of the current block (consumed) or the end of the file. */
  members(type, ns) {
    let doc = [];
    let attrs = [];
    while (this.i < this.t.length) {
      const tok = this.tok;
      if (tok.k === 'doc') {
        doc.push(tok.v);
        this.i++;
        continue;
      }
      if (this.isP('}')) {
        this.i++;
        return;
      }
      if (this.isP(';')) {
        this.i++;
        doc = [];
        attrs = [];
        continue;
      }
      if (this.isP('[')) {
        attrs.push(...this.attributes());
        continue;
      }
      if (!type && this.isId('global') && this.isId('using', 1)) {
        this.i++;
        this.usingDirective(true);
        continue;
      }
      if (!type && this.isId('using') && !this.isP('(', 1) && !this.isId('var', 1)) {
        this.usingDirective(false);
        continue;
      }
      if (!type && this.isId('namespace')) {
        ns = this.namespaceDeclaration(ns);
        doc = [];
        attrs = [];
        continue;
      }
      const start = this.i;
      const mods = this.modifiers();
      const keyword = this.typeKeyword();
      if (keyword) this.typeDeclaration(keyword, mods, attrs, doc, type, ns);
      else if (type) this.member(type, mods, attrs, doc);
      else {
        this.i = start;
        this.statement();
      }
      doc = [];
      attrs = [];
    }
  }

  usingDirective(isGlobal) {
    this.i++; // using
    let isStatic = false;
    if (this.isId('static')) {
      isStatic = true;
      this.i++;
    }
    if (this.isId() && this.isP('=', 1)) {
      const alias = this.tok.v;
      this.i += 2;
      const target = this.typeRef();
      if (target) this.out.aliases[alias] = target.name;
    } else if (!isStatic) {
      const name = this.dottedName();
      if (name) (isGlobal ? this.out.globalUsings : this.out.usings).push(name);
    }
    this.skipMember();
  }

  namespaceDeclaration(ns) {
    this.i++; // namespace
    const name = this.dottedName();
    const full = ns ? `${ns}.${name}` : name;
    if (this.isP(';')) {
      this.i++;
      this.fileNamespace = full;
      return full;
    }
    if (this.isP('{')) {
      this.i++;
      this.members(null, full);
    }
    return ns;
  }

  dottedName() {
    const parts = [];
    if (this.isId('global') && this.isP('::', 1)) this.i += 2;
    while (this.isId()) {
      parts.push(this.tok.v);
      this.i++;
      if (this.isP('.') && this.isId(undefined, 1)) this.i++;
      else break;
    }
    return parts.join('.');
  }

  modifiers() {
    const mods = [];
    while (this.isId() && !this.tok.verbatim && TYPE_MODIFIERS.has(this.tok.v)) {
      mods.push(this.tok.v);
      this.i++;
    }
    return mods;
  }

  typeKeyword() {
    const tok = this.tok;
    if (!tok || tok.k !== 'id' || tok.verbatim) return null;
    if (['class', 'struct', 'interface', 'enum', 'delegate'].includes(tok.v)) return tok.v;
    if (tok.v === 'record' && this.isId(undefined, 1)) return 'record';
    return null;
  }

  typeDeclaration(keyword, mods, attrs, doc, outer, ns) {
    this.i++;
    let kind = keyword;
    if (keyword === 'record') {
      if (this.isId('class')) this.i++;
      else if (this.isId('struct')) {
        this.i++;
        kind = 'record struct';
      }
    }
    let invoke = null;
    if (keyword === 'delegate') {
      invoke = { returns: this.typeRef() };
      if (!invoke.returns) return this.skipMember();
    }
    if (!this.isId()) return this.skipMember();
    const nameTok = this.tok;
    this.i++;
    const type = {
      name: nameTok.v,
      kind,
      namespace: ns,
      parent: outer ? outer.path : null,
      path: outer ? `${outer.path}.${nameTok.v}` : nameTok.v,
      typeParams: this.isP('<') ? this.typeParameters() : [],
      modifiers: mods,
      visibility: visibility(mods, outer ? 'private' : 'internal'),
      attributes: attrs,
      doc: summary(doc),
      line: nameTok.line,
      bases: [],
      parameters: null,
      members: [],
      refs: [],
    };
    this.out.types.push(type);
    if (invoke) {
      const params = this.isP('(') ? this.parameters() : [];
      this.constraints();
      type.members.push(memberOf({ kind: 'method', name: 'Invoke', visibility: 'public', type: invoke.returns, params }));
      return this.skipMember();
    }
    if (this.isP('(')) type.parameters = this.parameters();
    if (this.isP(':')) {
      this.i++;
      type.bases = this.baseList(type);
    }
    this.constraints();
    if (this.isP('{')) {
      this.i++;
      if (kind === 'enum') this.enumBody(type);
      else this.members(type, ns);
      if (this.isP(';')) this.i++;
    } else if (this.isP(';')) this.i++;
  }

  typeParameters() {
    const names = [];
    this.i++; // <
    let depth = 1;
    while (this.i < this.t.length && depth > 0) {
      if (this.isP('[')) {
        this.skipBalanced();
        continue;
      }
      if (this.isP('<')) depth++;
      else if (this.isP('>')) depth--;
      else if (depth === 1 && this.isId() && (this.isP(',', 1) || this.isP('>', 1))) names.push(this.tok.v);
      this.i++;
    }
    return names;
  }

  baseList(type) {
    const bases = [];
    for (;;) {
      const ref = this.typeRef();
      if (!ref) break;
      bases.push(ref);
      if (this.isP('(')) this.skipBalanced(type.refs); // record Derived(int X) : Base(X)
      if (!this.isP(',')) break;
      this.i++;
    }
    return bases;
  }

  constraints() {
    while (this.isId('where')) {
      this.i++;
      while (this.i < this.t.length && !this.isP('{') && !this.isP(';') && !this.isP('=>') && !this.isId('where')) {
        if (this.isP('(')) this.skipBalanced();
        else this.i++;
      }
    }
  }

  enumBody(type) {
    while (this.i < this.t.length) {
      if (this.isP('}')) {
        this.i++;
        return;
      }
      if (this.isP('[')) {
        this.attributes();
        continue;
      }
      if (this.isId()) {
        type.members.push(memberOf({ kind: 'value', name: this.tok.v, visibility: 'public', static: true }));
        this.i++;
        if (this.isP('=')) {
          this.i++;
          this.skipUntil([',', '}']);
        }
        continue;
      }
      this.i++;
    }
  }

  /** At `[`: one attribute section. Returns [{ name, args }] - args are the string literals passed to it. */
  attributes() {
    const found = [];
    this.i++; // [
    if (this.isId() && this.isP(':', 1)) this.i += 2; // a target: assembly:, return:, field:, …
    while (this.i < this.t.length && !this.isP(']')) {
      const ref = this.isId() ? this.typeRef() : null;
      if (!ref) {
        if (this.isP('(') || this.isP('[') || this.isP('{')) this.skipBalanced();
        else this.i++;
        continue;
      }
      const args = [];
      if (this.isP('(')) {
        const end = this.closing();
        for (let j = this.i; j < end; j++) if (this.t[j].k === 'str') args.push(this.t[j].v);
        this.i = end + 1;
      }
      found.push({ name: ref.name.split('.').pop().replace(/Attribute$/, ''), args });
    }
    this.i++; // ]
    return found;
  }

  /** At an opening bracket: the index of its closing bracket (or the last token). */
  closing() {
    let depth = 0;
    for (let j = this.i; j < this.t.length; j++) {
      const x = this.t[j];
      if (x.k !== 'p') continue;
      if (x.v === '(' || x.v === '[' || x.v === '{') depth++;
      else if (x.v === ')' || x.v === ']' || x.v === '}') {
        depth--;
        if (depth <= 0) return j;
      }
    }
    return this.t.length - 1;
  }

  member(type, mods, attrs, doc) {
    const base = {
      modifiers: mods,
      visibility: visibility(mods, type.kind === 'interface' ? 'public' : 'private'),
      static: mods.includes('static') || mods.includes('const'),
      abstract: mods.includes('abstract'),
      attributes: attrs,
      doc: summary(doc),
      refs: [],
    };
    const add = (m) => type.members.push(memberOf({ ...base, ...m }));

    if (this.isId('event')) {
      this.i++;
      const eventType = this.typeRef();
      if (!eventType || !this.isId()) return this.skipMember(base.refs);
      const name = this.tok.v;
      this.i++;
      if (this.isP('{')) this.skipBalanced(base.refs);
      else this.skipToSemicolon(base.refs);
      return add({ kind: 'event', name, type: eventType });
    }
    if (this.isP('~')) return this.skipMember(); // finaliser
    if (this.isId(type.name) && this.isP('(', 1)) {
      this.i++;
      const params = this.parameters();
      if (this.isP(':')) {
        this.i++;
        if (this.isId()) this.i++; // base or this
        if (this.isP('(')) this.skipBalanced(base.refs);
      }
      this.body(base.refs);
      return add({ kind: 'constructor', name: type.name, params });
    }
    if (this.isId('operator') && (mods.includes('implicit') || mods.includes('explicit'))) {
      this.i++;
      const target = this.typeRef();
      const params = this.isP('(') ? this.parameters() : [];
      this.body(base.refs);
      return add({ kind: 'operator', name: 'operator', type: target, params });
    }
    const memberType = this.typeRef();
    if (!memberType) return this.skipMember(base.refs);
    if (this.isId('operator')) {
      this.i++;
      while (this.i < this.t.length && !this.isP('(') && !this.isP(';') && !this.isP('{')) this.i++;
      const params = this.isP('(') ? this.parameters() : [];
      this.body(base.refs);
      return add({ kind: 'operator', name: 'operator', type: memberType, params });
    }
    if (this.isId('this') && this.isP('[', 1)) {
      this.i++;
      const params = this.parameters(']');
      this.accessors(base.refs);
      return add({ kind: 'indexer', name: 'this[]', type: memberType, params });
    }
    // The name, possibly qualified by an explicit interface (IFoo.Bar), with a generic method's type parameters.
    const start = this.i;
    const nameNode = this.typeNode();
    if (!nameNode || nameNode.tuple || nameNode.suffix) {
      this.i = start;
      return this.skipMember(base.refs);
    }
    const name = nameNode.name.split('.').pop();
    if (this.isP('(')) {
      const params = this.parameters();
      this.constraints();
      this.body(base.refs);
      return add({ kind: 'method', name, typeParams: nameNode.args.map(render), type: memberType, params });
    }
    if (this.isP('{') || this.isP('=>')) {
      this.accessors(base.refs);
      return add({ kind: 'property', name, type: memberType });
    }
    if (this.isP('=') || this.isP(';') || this.isP(',')) {
      const names = [name];
      for (;;) {
        if (this.isP('=')) {
          this.i++;
          this.skipInitializer(base.refs);
        }
        if (this.isP(',') && this.isId(undefined, 1)) {
          names.push(this.t[this.i + 1].v);
          this.i += 2;
          continue;
        }
        break;
      }
      if (this.isP(';')) this.i++;
      for (const n of names) add({ kind: 'field', name: n, type: memberType });
      return;
    }
    this.skipMember(base.refs);
  }

  /** At `(` (or `[` for an indexer): the parameter list, as [{ name, type }]. */
  parameters(close = ')') {
    const params = [];
    this.i++;
    for (let before = -1; this.i < this.t.length && !this.isP(close) && this.i !== before; ) {
      before = this.i; // a closing bracket that is not ours stops the list
      if (this.isP(',')) {
        this.i++;
        continue;
      }
      if (this.isP('[')) {
        this.attributes();
        continue;
      }
      while (this.isId() && !this.tok.verbatim && PARAMETER_MODIFIERS.has(this.tok.v) && this.isId(undefined, 1)) this.i++;
      const type = this.typeRef();
      if (!type) {
        this.skipUntil([',', close]);
        continue;
      }
      let name = '';
      if (this.isId()) {
        name = this.tok.v;
        this.i++;
      }
      if (this.isP('=')) {
        this.i++;
        this.skipUntil([',', close]);
      }
      params.push({ name, type });
    }
    if (this.isP(close)) this.i++;
    return params;
  }

  /** A method or constructor body: { … }, => …; or just ;. */
  body(refs) {
    if (this.isP('{')) this.skipBalanced(refs);
    else if (this.isP('=>')) {
      this.i++;
      this.skipToSemicolon(refs);
    } else if (this.isP(';')) this.i++;
  }

  /** A property's or indexer's { get; set; } [= value;] or => expression;. */
  accessors(refs) {
    if (this.isP('{')) {
      this.skipBalanced(refs);
      if (this.isP('=')) {
        this.i++;
        this.skipToSemicolon(refs);
      }
    } else if (this.isP('=>')) {
      this.i++;
      this.skipToSemicolon(refs);
    }
  }

  // --- Types --------------------------------------------------------------

  typeRef() {
    const start = this.i;
    const node = this.typeNode();
    if (!node) {
      this.i = start;
      return null;
    }
    const refs = [];
    collect(node, false, refs);
    return { text: render(node), name: node.name || '', refs };
  }

  /** A type: Name, A.B<C, D>, (int X, string Y), with ?, [] and * suffixes. Null if there is none here. */
  typeNode() {
    let node;
    if (this.isP('(')) {
      this.i++;
      const items = [];
      for (;;) {
        const type = this.typeNode();
        if (!type) return null;
        let name = null;
        if (this.isId() && (this.isP(',', 1) || this.isP(')', 1))) {
          name = this.tok.v;
          this.i++;
        }
        items.push({ type, name });
        if (this.isP(',')) {
          this.i++;
          continue;
        }
        if (!this.isP(')')) return null;
        this.i++;
        break;
      }
      if (items.length < 2) return null;
      node = { name: null, args: [], tuple: items, suffix: '' };
    } else {
      if (!this.isId()) return null;
      if (this.isId('global') && this.isP('::', 1)) this.i += 2;
      const parts = [];
      let args = [];
      for (;;) {
        if (!this.isId()) return null;
        parts.push(this.tok.v);
        this.i++;
        if (this.isP('<')) {
          const a = this.typeArguments();
          if (!a) return null;
          args = args.concat(a);
        }
        if ((this.isP('.') || this.isP('::')) && this.isId(undefined, 1)) {
          this.i++;
          continue;
        }
        break;
      }
      node = { name: parts.join('.'), args, tuple: null, suffix: '' };
    }
    for (;;) {
      if (this.isP('?') || this.isP('*')) {
        node.suffix += this.tok.v;
        this.i++;
        continue;
      }
      if (this.isP('[')) {
        let j = 1;
        while (this.isP(',', j)) j++;
        if (!this.isP(']', j)) break;
        node.suffix += `[${','.repeat(j - 1)}]`;
        this.i += j + 1;
        continue;
      }
      break;
    }
    return node;
  }

  typeArguments() {
    this.i++; // <
    const args = [];
    for (;;) {
      if (this.isP('>')) {
        this.i++;
        return args;
      }
      if (this.isP(',')) {
        this.i++; // an unbound generic: typeof(Dictionary<,>)
        continue;
      }
      const arg = this.typeNode();
      if (!arg) return null;
      args.push(arg);
      if (this.isP(',')) this.i++;
      else if (!this.isP('>')) return null;
    }
  }

  // --- Skipping, noting the type names used --------------------------------

  /** At an identifier: read a dotted name (A.B.C) and note it in `refs` if it may name a type. */
  chain(refs) {
    const prev = this.t[this.i - 1];
    const parts = [this.tok.v];
    let j = this.i + 1;
    while (this.t[j]?.k === 'p' && this.t[j].v === '.' && this.t[j + 1]?.k === 'id') {
      parts.push(this.t[j + 1].v);
      j += 2;
    }
    const memberAccess = prev?.k === 'p' && (prev.v === '.' || prev.v === '?.' || prev.v === '->');
    if (!memberAccess && /^\p{Lu}/u.test(parts[0])) {
      const name = parts.join('.');
      if (!refs.includes(name)) refs.push(name);
    }
    this.i = j;
  }

  /** At an opening bracket: skip to just past its closing bracket. */
  skipBalanced(refs) {
    let depth = 0;
    while (this.i < this.t.length) {
      const t = this.tok;
      if (t.k === 'p') {
        if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
        else if (t.v === ')' || t.v === ']' || t.v === '}') {
          depth--;
          if (depth <= 0) {
            this.i++;
            return;
          }
        }
      } else if (refs && t.k === 'id') {
        this.chain(refs);
        continue;
      }
      this.i++;
    }
  }

  /** Skip to just past the next `;` outside brackets, or to (not past) a `}` that closes the enclosing block. */
  skipToSemicolon(refs) {
    while (this.i < this.t.length) {
      const t = this.tok;
      if (t.k === 'p') {
        if (t.v === ';') {
          this.i++;
          return;
        }
        if (t.v === '}' || t.v === ')' || t.v === ']') return;
        if (t.v === '(' || t.v === '[' || t.v === '{') {
          this.skipBalanced(refs);
          continue;
        }
      } else if (refs && t.k === 'id') {
        this.chain(refs);
        continue;
      }
      this.i++;
    }
  }

  /** Skip to (not past) the first of `stops` outside brackets, or a closing bracket of the enclosing block. */
  skipUntil(stops, refs) {
    while (this.i < this.t.length) {
      const t = this.tok;
      if (t.k === 'p') {
        if (stops.includes(t.v) || t.v === ')' || t.v === ']' || t.v === '}' || t.v === ';') return;
        if (t.v === '(' || t.v === '[' || t.v === '{') {
          this.skipBalanced(refs);
          continue;
        }
      } else if (refs && t.k === 'id') {
        this.chain(refs);
        continue;
      }
      this.i++;
    }
  }

  /** A field initializer: up to the `;`, or the `,` that starts the next declarator (`, name =`, `, name;`). */
  skipInitializer(refs) {
    while (this.i < this.t.length) {
      if (this.isP(',') && this.isId(undefined, 1) && (this.isP('=', 2) || this.isP(';', 2) || this.isP(',', 2))) return;
      const before = this.i;
      this.skipUntil([','], refs);
      if (this.isP(',') && this.i === before) this.i++;
      else if (!this.isP(',')) return;
    }
  }

  /** Skip a member or statement this reader does not follow. */
  skipMember(refs) {
    while (this.i < this.t.length) {
      if (this.isP(';')) {
        this.i++;
        return;
      }
      if (this.isP('}')) return;
      if (this.isP('{')) {
        this.skipBalanced(refs);
        if (this.isP(';')) this.i++;
        return;
      }
      if (this.isP('(') || this.isP('[')) {
        this.skipBalanced(refs);
        continue;
      }
      if (refs && this.isId()) {
        this.chain(refs);
        continue;
      }
      this.i++;
    }
  }

  /** A top-level statement (Program.cs), kept as its tokens. */
  statement() {
    const start = this.i;
    this.skipMember();
    if (this.i === start) this.i++;
    this.out.statements.push(this.t.slice(start, this.i));
  }
}

function memberOf(m) {
  return {
    kind: m.kind,
    name: m.name,
    visibility: m.visibility ?? 'public',
    static: Boolean(m.static),
    abstract: Boolean(m.abstract),
    modifiers: m.modifiers ?? [],
    attributes: m.attributes ?? [],
    doc: m.doc ?? '',
    type: m.type ?? null,
    params: m.params ?? [],
    typeParams: m.typeParams ?? [],
    refs: m.refs ?? [],
  };
}

function visibility(mods, fallback) {
  if (mods.includes('public')) return 'public';
  if (mods.includes('protected')) return 'protected';
  if (mods.includes('internal')) return 'internal';
  if (mods.includes('private') || mods.includes('file')) return 'private';
  return fallback;
}

/** The text of a /// comment: its <summary> if it has one, without tags (a <see cref="X"/> becomes X). */
function summary(lines) {
  if (!lines.length) return '';
  let text = lines.join('\n');
  const m = /<summary>([\s\S]*?)<\/summary>/.exec(text);
  if (m) text = m[1];
  return text
    .replace(/<(?:see|seealso|paramref|typeparamref)\s+(?:cref|name|langword)="(?:[A-Z]:)?([^"]*)"\s*\/>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function render(node) {
  const base = node.tuple
    ? `(${node.tuple.map((item) => render(item.type) + (item.name ? ` ${item.name}` : '')).join(', ')})`
    : node.name + (node.args.length ? `<${node.args.map(render).join(', ')}>` : '');
  return base + node.suffix;
}

function collect(node, many, refs) {
  const held = many || node.suffix.includes('[');
  if (node.tuple) {
    for (const item of node.tuple) collect(item.type, held, refs);
    return;
  }
  refs.push({ name: node.name, many: held });
  const inner = held || COLLECTIONS.has(node.name.split('.').pop());
  for (const arg of node.args) collect(arg, inner, refs);
}
