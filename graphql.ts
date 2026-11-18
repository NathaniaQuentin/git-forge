// GraphQL API at /api/graphql — a small, dependency-free executor for the
// documents the suite sends (queries, the five mutations, introspection,
// batching, inline fragments, aliases, inline enums/input objects).
//
// Transport: POST only; no Authorization header is exactly 401. GraphQL-level
// failures (unknown field, bad argument) are HTTP 200 with an `errors`
// array; an unknown repository is data.repository === null with no errors.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN, VIEWER_ID } from './store.ts';
import type { Store, Repo, Issue, Pull } from './store.ts';
import {
  addCommentObj,
  createIssueObj,
  createPullObj,
  mergePull,
  prFilesOf,
  prMergeable,
  readJsonBody,
  sendJson,
  sendError,
  type RestContext,
} from './rest.ts';

// ------------------------------------------------------------------ global ids

export function gid(...parts: Array<string | number>): string {
  return Buffer.from(parts.join(':')).toString('base64');
}

export function parseGid(id: string): string[] | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const decoded = Buffer.from(id, 'base64').toString('ascii');
    const parts = decoded.split(':');
    if (parts.length < 2) return null;
    if (Buffer.from(decoded).toString('base64') !== id && Buffer.from(decoded).toString('base64').replace(/=+$/, '') !== id.replace(/=+$/, '')) {
      // Tolerate missing padding.
    }
    return parts;
  } catch {
    return null;
  }
}

function repoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return undefined;
}

// ------------------------------------------------------------------ schema

interface FieldDef {
  type: string;
}
interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE' | 'INPUT_OBJECT' | 'SCALAR';
  fields?: Record<string, FieldDef>;
  values?: string[];
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User' },
      repository: { type: 'Repository' },
      node: { type: 'Node' },
      __type: { type: '__Type' },
      __schema: { type: '__Schema' },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: { type: 'CreateIssuePayload' },
      closeIssue: { type: 'CloseIssuePayload' },
      createPullRequest: { type: 'CreatePullRequestPayload' },
      mergePullRequest: { type: 'MergePullRequestPayload' },
      addComment: { type: 'AddCommentPayload' },
    },
  },
  User: { kind: 'OBJECT', fields: { login: { type: 'String' } } },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      databaseId: { type: 'Int' },
      name: { type: 'String' },
      nameWithOwner: { type: 'String' },
      owner: { type: 'User' },
      defaultBranchRef: { type: 'Ref' },
      viewerPermission: { type: 'RepositoryPermission' },
      hasIssuesEnabled: { type: 'Boolean' },
      issue: { type: 'Issue' },
      issues: { type: 'IssueConnection' },
      pullRequests: { type: 'PullRequestConnection' },
      pullRequest: { type: 'PullRequest' },
    },
  },
  Ref: { kind: 'OBJECT', fields: { name: { type: 'String' } } },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      number: { type: 'Int' },
      title: { type: 'String' },
      state: { type: 'IssueState' },
      body: { type: 'String' },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Issue]' },
      edges: { type: '[IssueEdge]' },
      pageInfo: { type: 'PageInfo' },
      totalCount: { type: 'Int' },
    },
  },
  IssueEdge: { kind: 'OBJECT', fields: { node: { type: 'Issue' }, cursor: { type: 'String' } } },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean' },
      hasPreviousPage: { type: 'Boolean' },
      startCursor: { type: 'String' },
      endCursor: { type: 'String' },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      number: { type: 'Int' },
      headRefName: { type: 'String' },
      baseRefName: { type: 'String' },
      mergeable: { type: 'MergeableState' },
      state: { type: 'PullRequestState' },
      merged: { type: 'Boolean' },
      files: { type: 'PullRequestChangedFileConnection' },
      title: { type: 'String' },
      body: { type: 'String' },
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequest]' },
      edges: { type: '[PullRequestEdge]' },
      pageInfo: { type: 'PageInfo' },
      totalCount: { type: 'Int' },
    },
  },
  PullRequestEdge: { kind: 'OBJECT', fields: { node: { type: 'PullRequest' }, cursor: { type: 'String' } } },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequestChangedFile]' },
      edges: { type: '[PullRequestChangedFileEdge]' },
      pageInfo: { type: 'PageInfo' },
      totalCount: { type: 'Int' },
    },
  },
  PullRequestChangedFileEdge: { kind: 'OBJECT', fields: { node: { type: 'PullRequestChangedFile' }, cursor: { type: 'String' } } },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String' },
      additions: { type: 'Int' },
      deletions: { type: 'Int' },
      changeType: { type: 'String' },
    },
  },
  IssueComment: { kind: 'OBJECT', fields: { id: { type: 'ID' }, body: { type: 'String' } } },
  IssueCommentEdge: { kind: 'OBJECT', fields: { node: { type: 'IssueComment' }, cursor: { type: 'String' } } },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } } },
  AddCommentPayload: { kind: 'OBJECT', fields: { commentEdge: { type: 'IssueCommentEdge' }, clientMutationId: { type: 'String' } } },
  Node: { kind: 'INTERFACE', fields: { id: { type: 'ID' } } },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      description: { type: 'String' },
      types: { type: '[__Type]' },
      queryType: { type: '__Type' },
      mutationType: { type: '__Type' },
      directives: { type: '[__Directive]' },
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      kind: { type: '__TypeKind' },
      name: { type: 'String' },
      description: { type: 'String' },
      fields: { type: '[__Field]' },
      enumValues: { type: '[__EnumValue]' },
      inputFields: { type: '[__InputValue]' },
      interfaces: { type: '[__Type]' },
      possibleTypes: { type: '[__Type]' },
      specifiedByURL: { type: 'String' },
      ofType: { type: '__Type' },
      isOneOf: { type: 'Boolean' },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      args: { type: '[__InputValue]' },
      type: { type: '__Type' },
      isDeprecated: { type: 'Boolean' },
      deprecationReason: { type: 'String' },
    },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      type: { type: '__Type' },
      defaultValue: { type: 'String' },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      isDeprecated: { type: 'Boolean' },
      deprecationReason: { type: 'String' },
    },
  },
  __Directive: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      locations: { type: '[__DirectiveLocation]' },
      args: { type: '[__InputValue]' },
      isRepeatable: { type: 'Boolean' },
    },
  },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION', 'PROJECT'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
  __TypeKind: { kind: 'ENUM', values: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'] },
  __DirectiveLocation: {
    kind: 'ENUM',
    values: ['QUERY', 'MUTATION', 'SUBSCRIPTION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT', 'SCHEMA', 'SCALAR', 'OBJECT', 'FIELD_DEFINITION', 'ARGUMENT_DEFINITION', 'INTERFACE', 'UNION', 'ENUM', 'ENUM_VALUE', 'INPUT_OBJECT', 'INPUT_FIELD_DEFINITION'],
  },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
};

function baseType(type: string): string {
  return type.replace(/[!\[\]]/g, '');
}

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string' | 'int' | 'float' | 'boolean' | 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldSel {
  kind: 'field';
  name: string;
  alias?: string;
  args: Record<string, ValueNode>;
  selectionSet?: Selection[];
}
interface FragmentSel {
  kind: 'fragment';
  typeCondition?: string;
  selectionSet: Selection[];
}
type Selection = FieldSel | FragmentSel;

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  variables: Record<string, unknown>;
  varDefs: Record<string, { type: string; defaultValue?: ValueNode }>;
  selectionSet: Selection[];
}

class Lexer {
  pos = 0;
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  private skipIgnored(): void {
    for (;;) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { this.pos += 1; continue; }
      if (c === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  /** The next token, without consuming it. */
  peek(): string {
    const save = this.pos;
    const tok = this.next();
    this.pos = save;
    return tok;
  }

  next(): string {
    this.skipIgnored();
    const s = this.src;
    if (this.pos >= s.length) return '';
    const c = s[this.pos];
    if (c === '.' && s.slice(this.pos, this.pos + 3) === '...') { this.pos += 3; return '...'; }
    if ('{}()[]:!=$@'.includes(c)) { this.pos += 1; return c; }
    if (c === '"') {
      if (s.slice(this.pos, this.pos + 3) === '"""') {
        const end = s.indexOf('"""', this.pos + 3);
        const text = end < 0 ? s.slice(this.pos + 3) : s.slice(this.pos + 3, end);
        this.pos = end < 0 ? s.length : end + 3;
        return JSON.stringify(text);
      }
      let i = this.pos + 1;
      let out = '';
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          const e = s[i + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          out += map[e] ?? e;
          i += 2;
        } else {
          out += s[i];
          i += 1;
        }
      }
      this.pos = i + 1;
      return JSON.stringify(out);
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*|^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(this.pos));
    if (m !== null) {
      this.pos += m[0].length;
      return m[0];
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${this.pos}`);
  }

  expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new Error(`expected ${JSON.stringify(tok)} but got ${JSON.stringify(got)}`);
  }
}

function parseValue(lex: Lexer): ValueNode {
  const tok = lex.peek();
  if (tok === '$') {
    lex.next();
    return { kind: 'variable', name: lex.next() };
  }
  if (tok === '[') {
    lex.next();
    const items: ValueNode[] = [];
    while (lex.peek() !== ']') items.push(parseValue(lex));
    lex.expect(']');
    return { kind: 'list', items };
  }
  if (tok === '{') {
    lex.next();
    const fields: Record<string, ValueNode> = {};
    while (lex.peek() !== '}') {
      const name = lex.next();
      lex.expect(':');
      fields[name] = parseValue(lex);
    }
    lex.expect('}');
    return { kind: 'object', fields };
  }
  const raw = lex.next();
  if (raw.startsWith('"')) return { kind: 'string', value: JSON.parse(raw) as string };
  if (raw === 'true' || raw === 'false') return { kind: 'boolean', value: raw };
  if (raw === 'null') return { kind: 'null' };
  if (/^-?\d+$/.test(raw)) return { kind: 'int', value: raw };
  if (/^-?\d*\.\d+/.test(raw)) return { kind: 'float', value: raw };
  return { kind: 'enum', value: raw };
}

function parseSelectionSet(lex: Lexer): Selection[] {
  lex.expect('{');
  const out: Selection[] = [];
  while (lex.peek() !== '}') {
    if (lex.peek() === '...') {
      lex.next();
      const next = lex.peek();
      if (next === 'on') {
        lex.next();
        const typeCondition = lex.next();
        out.push({ kind: 'fragment', typeCondition, selectionSet: parseSelectionSet(lex) });
      } else if (next === '{') {
        out.push({ kind: 'fragment', selectionSet: parseSelectionSet(lex) });
      } else {
        // Named fragment spread: parse the name and expand later; the
        // documents we serve do not use named fragments, so treat the
        // spread as an inline fragment over the same type.
        lex.next();
        out.push({ kind: 'fragment', selectionSet: [] });
      }
      continue;
    }
    const first = lex.next();
    let alias: string | undefined;
    let name = first;
    if (lex.peek() === ':') {
      lex.next();
      alias = first;
      name = lex.next();
    }
    const args: Record<string, ValueNode> = {};
    if (lex.peek() === '(') {
      lex.next();
      while (lex.peek() !== ')') {
        const argName = lex.next();
        lex.expect(':');
        args[argName] = parseValue(lex);
      }
      lex.expect(')');
    }
    // Directives (e.g. @include) are not used by the suite; skip them.
    while (lex.peek() === '@') {
      lex.next();
      lex.next();
      if (lex.peek() === '(') {
        lex.next();
        let depth = 1;
        while (depth > 0) {
          const t = lex.next();
          if (t === '(') depth += 1;
          else if (t === ')') depth -= 1;
        }
      }
    }
    const selectionSet = lex.peek() === '{' ? parseSelectionSet(lex) : undefined;
    out.push({ kind: 'field', name, alias, args, selectionSet });
  }
  lex.expect('}');
  return out;
}

function parseType(lex: Lexer): string {
  if (lex.peek() === '[') {
    lex.next();
    const inner = parseType(lex);
    lex.expect(']');
    return lex.peek() === '!' ? (lex.next(), `[${inner}]!`) : `[${inner}]`;
  }
  const name = lex.next();
  return lex.peek() === '!' ? (lex.next(), `${name}!`) : name;
}

function parseDocument(src: string): Operation[] {
  const lex = new Lexer(src);
  const ops: Operation[] = [];
  while (lex.peek() !== '') {
    const tok = lex.peek();
    if (tok === 'fragment') {
      // Skip fragment definitions (unused by the suite's documents).
      lex.next();
      lex.next();
      lex.next();
      lex.next();
      parseSelectionSet(lex);
      continue;
    }
    let type: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    if (tok === 'query' || tok === 'mutation') {
      type = lex.next() as 'query' | 'mutation';
      const next = lex.peek();
      if (next !== '' && next !== '(' && next !== '{') name = lex.next();
    }
    const varDefs: Record<string, { type: string; defaultValue?: ValueNode }> = {};
    if (lex.peek() === '(') {
      lex.next();
      while (lex.peek() !== ')') {
        lex.expect('$');
        const varName = lex.next();
        lex.expect(':');
        const varType = parseType(lex);
        let defaultValue: ValueNode | undefined;
        if (lex.peek() === '=') {
          lex.next();
          defaultValue = parseValue(lex);
        }
        varDefs[varName] = { type: varType, defaultValue };
      }
      lex.expect(')');
    }
    const selectionSet = parseSelectionSet(lex);
    ops.push({ type, name, variables: {}, varDefs, selectionSet });
  }
  return ops;
}

// ------------------------------------------------------------------ executor

type GqlValue = Record<string, unknown> & { __typename?: string };
interface ExecError { message: string; path?: Array<string | number> }

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': return node.value;
    case 'int': return Number.parseInt(node.value, 10);
    case 'float': return Number.parseFloat(node.value);
    case 'boolean': return node.value === 'true';
    case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.items.map((i) => evalValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = evalValue(v, variables);
      return out;
    }
  }
}

function evalArgs(field: FieldSel, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) out[k] = evalValue(v, variables);
  return out;
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`).toString('base64');
}

function seqFromCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('ascii');
    const m = /^cursor:(\d+)$/.exec(decoded);
    return m === null ? null : Number.parseInt(m[1], 10);
  } catch {
    return null;
  }
}

function pageInfoFor<T extends { seq: number }>(page: T[], total: number): Record<string, unknown> {
  const hasNextPage = page.length > 0 ? total > 0 : false;
  return {
    __typename: 'PageInfo',
    hasNextPage,
    hasPreviousPage: false,
    startCursor: page.length > 0 ? cursorFor(page[0].seq) : null,
    endCursor: page.length > 0 ? cursorFor(page[page.length - 1].seq) : null,
  };
}

interface Ctx {
  store: Store;
}

function userNode(login: string, id: number): GqlValue {
  return { __typename: 'User', login, id };
}

function issueNode(store: Store, repo: Repo, issue: Issue): GqlValue {
  return {
    __typename: 'Issue',
    id: gid('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function pullNode(store: Store, repo: Repo, pull: Pull): GqlValue {
  return {
    __typename: 'PullRequest',
    id: gid('PullRequest', repo.id, pull.number),
    number: pull.number,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: prMergeable(repo, pull),
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    title: pull.title,
    body: pull.body,
    files: (args: Record<string, unknown>) => {
      const all = prFilesOf(repo, pull).map((f, i) => ({
        __typename: 'PullRequestChangedFile',
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED',
        seq: i + 1,
      }));
      const first = typeof args.first === 'number' ? args.first : all.length;
      const page = all.slice(0, first);
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: page,
        edges: page.map((n) => ({ __typename: 'PullRequestChangedFileEdge', node: n, cursor: cursorFor(n.seq) })),
        pageInfo: pageInfoFor(page, all.length - page.length),
        totalCount: all.length,
      };
    },
  };
}

function repoNode(store: Store, repo: Repo): GqlValue {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    __typename: 'Repository',
    id: gid('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userNode(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0),
    defaultBranchRef: tip !== undefined ? { __typename: 'Ref', name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    issue: (args: Record<string, unknown>) => {
      const issue = repo.issues.find((i) => i.number === args.number);
      return issue === undefined ? null : issueNode(store, repo, issue);
    },
    issues: (args: Record<string, unknown>) => {
      let list = [...repo.issues];
      if (Array.isArray(args.states)) {
        const wanted = new Set((args.states as string[]).map((s) => s.toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = orderBy.direction === 'ASC' ? 1 : -1;
      list.sort((a, b) => (a.seq - b.seq) * direction);
      if (typeof args.after === 'string') {
        const seq = seqFromCursor(args.after);
        if (seq !== null) {
          const idx = list.findIndex((i) => i.seq === seq);
          if (idx >= 0) list = list.slice(idx + 1);
        }
      }
      const first = typeof args.first === 'number' ? args.first : list.length;
      const total = list.length;
      const page = list.slice(0, first);
      return {
        __typename: 'IssueConnection',
        nodes: page.map((i) => issueNode(store, repo, i)),
        edges: page.map((i) => ({ __typename: 'IssueEdge', node: issueNode(store, repo, i), cursor: cursorFor(i.seq) })),
        pageInfo: pageInfoFor(page, total - page.length),
        totalCount: total,
      };
    },
    pullRequests: (args: Record<string, unknown>) => {
      const list = [...repo.pulls].sort((a, b) => b.seq - a.seq);
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(0, first);
      return {
        __typename: 'PullRequestConnection',
        nodes: page.map((p) => pullNode(store, repo, p)),
        edges: page.map((p) => ({ __typename: 'PullRequestEdge', node: pullNode(store, repo, p), cursor: cursorFor(p.seq) })),
        pageInfo: pageInfoFor(page, list.length - page.length),
        totalCount: list.length,
      };
    },
    pullRequest: (args: Record<string, unknown>) => {
      const pull = repo.pulls.find((p) => p.number === args.number);
      return pull === undefined ? null : pullNode(store, repo, pull);
    },
  };
}

function introspectionType(name: string): GqlValue | null {
  const def = SCHEMA[name];
  if (def === undefined) return null;
  return {
    __typename: '__Type',
    kind: def.kind,
    name,
    description: null,
    fields: (args: Record<string, unknown>) => {
      if (def.kind !== 'OBJECT' && def.kind !== 'INTERFACE') return null;
      return Object.entries(def.fields ?? {}).map(([fieldName]) => ({
        __typename: '__Field',
        name: fieldName,
        description: null,
        args: [],
        type: null,
        isDeprecated: false,
        deprecationReason: null,
      }));
    },
    enumValues: (args: Record<string, unknown>) => {
      if (def.kind !== 'ENUM') return null;
      return (def.values ?? []).map((v) => ({
        __typename: '__EnumValue',
        name: v,
        description: null,
        isDeprecated: false,
        deprecationReason: null,
      }));
    },
    inputFields: null,
    interfaces: [],
    possibleTypes: [],
    specifiedByURL: null,
    ofType: null,
    isOneOf: false,
  };
}

function decodeIdToRepo(store: Store, id: string): Repo | null {
  const parts = parseGid(id);
  if (parts === null || parts[0] !== 'Repository') return null;
  return repoById(store, Number(parts[1])) ?? null;
}

function decodeIdToIssue(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const parts = parseGid(id);
  if (parts === null || parts[0] !== 'Issue' || parts.length !== 3) return null;
  const repo = repoById(store, Number(parts[1]));
  if (repo === undefined) return null;
  const issue = repo.issues.find((i) => i.number === Number(parts[2]));
  return issue === undefined ? null : { repo, issue };
}

function decodeIdToPull(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const parts = parseGid(id);
  if (parts === null || parts[0] !== 'PullRequest' || parts.length !== 3) return null;
  const repo = repoById(store, Number(parts[1]));
  if (repo === undefined) return null;
  const pull = repo.pulls.find((p) => p.number === Number(parts[2]));
  return pull === undefined ? null : { repo, pull };
}

function rootQuery(ctx: Ctx): GqlValue {
  return {
    __typename: 'Query',
    viewer: () => userNode(VIEWER_LOGIN, VIEWER_ID),
    repository: (args: Record<string, unknown>) => {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoNode(ctx.store, repo);
    },
    node: (args: Record<string, unknown>) => {
      const id = String(args.id ?? '');
      const parts = parseGid(id);
      if (parts === null) return null;
      if (parts[0] === 'Repository') {
        const repo = repoById(ctx.store, Number(parts[1]));
        return repo === undefined ? null : repoNode(ctx.store, repo);
      }
      if (parts[0] === 'Issue') {
        const found = decodeIdToIssue(ctx.store, id);
        return found === null ? null : issueNode(ctx.store, found.repo, found.issue);
      }
      if (parts[0] === 'PullRequest') {
        const found = decodeIdToPull(ctx.store, id);
        return found === null ? null : pullNode(ctx.store, found.repo, found.pull);
      }
      return null;
    },
    __type: (args: Record<string, unknown>) => introspectionType(String(args.name ?? '')),
    __schema: () => ({
      __typename: '__Schema',
      description: null,
      types: Object.keys(SCHEMA).map((n) => introspectionType(n)),
      queryType: introspectionType('Query'),
      mutationType: introspectionType('Mutation'),
      directives: [],
    }),
  };
}

function rootMutation(ctx: Ctx): GqlValue {
  return {
    __typename: 'Mutation',
    createIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = decodeIdToRepo(ctx.store, String(input.repositoryId ?? ''));
      if (repo === null) throw new Error('repository not found');
      const issue = createIssueObj(ctx.store, repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      return { __typename: 'CreateIssuePayload', issue: issueNode(ctx.store, repo, issue), clientMutationId: null };
    },
    closeIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = decodeIdToIssue(ctx.store, String(input.issueId ?? ''));
      if (found === null) throw new Error('issue not found');
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueNode(ctx.store, found.repo, found.issue), clientMutationId: null };
    },
    createPullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = decodeIdToRepo(ctx.store, String(input.repositoryId ?? ''));
      if (repo === null) throw new Error('repository not found');
      const pull = createPullObj(
        ctx.store, repo,
        String(input.headRefName ?? ''), String(input.baseRefName ?? ''),
        String(input.title ?? ''), typeof input.body === 'string' ? input.body : '',
      );
      if (pull === null) throw new Error('head or base branch does not exist');
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(ctx.store, repo, pull), clientMutationId: null };
    },
    mergePullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = decodeIdToPull(ctx.store, String(input.pullRequestId ?? ''));
      if (found === null) throw new Error('pull request not found');
      const sha = mergePull(found.repo, found.pull);
      if (sha === null) throw new Error('pull request cannot be merged');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(ctx.store, found.repo, found.pull), clientMutationId: null };
    },
    addComment: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = decodeIdToIssue(ctx.store, String(input.subjectId ?? ''));
      if (found === null) throw new Error('issue not found');
      const comment = addCommentObj(found.repo, found.issue, String(input.body ?? ''));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: gid('IssueComment', found.repo.id, found.issue.number, comment.id), body: comment.body },
          cursor: cursorFor(comment.id),
        },
        clientMutationId: null,
      };
    },
  };
}

function resolveSelections(
  parent: GqlValue,
  parentType: string,
  selections: Selection[],
  variables: Record<string, unknown>,
  errors: ExecError[],
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeDef = SCHEMA[parentType];
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      const condType = sel.typeCondition ?? parentType;
      if (sel.typeCondition !== undefined && sel.typeCondition !== parent.__typename && sel.typeCondition !== parentType) continue;
      const nested = resolveSelections(parent, condType, sel.selectionSet, variables, errors, ctx);
      Object.assign(out, nested);
      continue;
    }
    const responseKey = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[responseKey] = parent.__typename ?? parentType;
      continue;
    }
    const fieldDef = typeDef?.fields?.[sel.name];
    if (fieldDef === undefined) {
      errors.push({ message: `Cannot query field "${sel.name}" on type "${parentType}".` });
      continue;
    }
    let value: unknown;
    try {
      const raw = (parent as Record<string, unknown>)[sel.name];
      value = typeof raw === 'function' ? (raw as (a: Record<string, unknown>) => unknown)(evalArgs(sel, variables)) : raw;
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : 'resolver error' });
      out[responseKey] = null;
      continue;
    }
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (sel.selectionSet !== undefined) {
      const childType = baseType(fieldDef.type);
      if (Array.isArray(value)) {
        out[responseKey] = value.map((item) =>
          item !== null && typeof item === 'object'
            ? resolveSelections(item as GqlValue, childType, sel.selectionSet as Selection[], variables, errors, ctx)
            : item,
        );
      } else if (typeof value === 'object') {
        out[responseKey] = resolveSelections(value as GqlValue, childType, sel.selectionSet, variables, errors, ctx);
      } else {
        out[responseKey] = value;
      }
    } else {
      out[responseKey] = value;
    }
  }
  return out;
}

function executeOperation(op: Operation, variables: Record<string, unknown>, ctx: Ctx): { data: Record<string, unknown> | null; errors: ExecError[] } {
  const errors: ExecError[] = [];
  const vars: Record<string, unknown> = { ...variables };
  for (const [name, def] of Object.entries(op.varDefs)) {
    if (vars[name] === undefined && def.defaultValue !== undefined) vars[name] = evalValue(def.defaultValue, vars);
  }
  const root = op.type === 'mutation' ? rootMutation(ctx) : rootQuery(ctx);
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveSelections(root, rootType, op.selectionSet, vars, errors, ctx);
  return { data, errors };
}

function executeDocument(query: string, variables: Record<string, unknown>, operationName: string | undefined, ctx: Ctx): { data: unknown; errors: ExecError[] } {
  let ops: Operation[];
  try {
    ops = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  if (ops.length === 0) return { data: null, errors: [{ message: 'no operation found in document' }] };
  let op: Operation | undefined;
  if (operationName !== undefined) op = ops.find((o) => o.name === operationName);
  else op = ops[0];
  if (op === undefined) return { data: null, errors: [{ message: `unknown operation ${operationName}` }] };
  return executeOperation(op, variables, ctx);
}

// ------------------------------------------------------------------ HTTP

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${ctx.host}`);
  if (url.pathname !== '/api/graphql') return false;
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') return sendError(res, ctx, 404, 'Not Found'), true;
  const auth = req.headers.authorization;
  if (auth === undefined || !/^Bearer\s+\S+/.test(auth.trim())) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'X-GitHub-Request-Id': `req-${++ctx.reqSeq.value}` });
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return true;
  }
  const body = await readJsonBody(req);
  if (!body.ok) {
    return sendJson(res, ctx, 400, { data: null, errors: [{ message: body.error }] }), true;
  }
  const gqlCtx: Ctx = { store: ctx.store };
  if (Array.isArray(body.value)) {
    const results = body.value.map((entry) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      const query = typeof e.query === 'string' ? e.query : '';
      const variables = (e.variables ?? {}) as Record<string, unknown>;
      const operationName = typeof e.operationName === 'string' ? e.operationName : undefined;
      return executeDocument(query, variables, operationName, gqlCtx);
    });
    return sendJson(res, ctx, 200, results), true;
  }
  const v = (body.value ?? {}) as Record<string, unknown>;
  const query = typeof v.query === 'string' ? v.query : '';
  const variables = (v.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof v.operationName === 'string' ? v.operationName : undefined;
  const result = executeDocument(query, variables, operationName, gqlCtx);
  return sendJson(res, ctx, 200, result), true;
}
