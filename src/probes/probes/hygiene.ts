/** P2 — deterministic entropy and clock hygiene. */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';

import type { ProbeReport } from '../../contracts/stats';
import type { ProbeDefinition } from '../probe';
import { makeReport } from '../probe';

const SCANNED_DIRECTORIES = ['sim', 'stats', 'probes', 'contracts'];
const EXEMPT_FILES = ['probes/timing.ts'];

const BANNED_OBJECT_MEMBERS = new Map<string, ReadonlySet<string>>([
  ['Math', new Set(['random'])],
  ['Date', new Set(['now'])],
  ['performance', new Set(['now', 'timeOrigin'])],
  ['process', new Set(['hrtime', 'uptime'])],
  ['console', new Set(['time', 'timeEnd', 'timeLog'])],
  [
    'crypto',
    new Set([
      'getRandomValues',
      'pseudoRandomBytes',
      'randomBytes',
      'randomFill',
      'randomFillSync',
      'randomInt',
      'randomUUID',
    ]),
  ],
  ['crypto.webcrypto', new Set(['getRandomValues', 'randomUUID'])],
  ['Temporal.Now', new Set(['*'])],
]);

const CRYPTO_MODULES = new Set(['crypto', 'node:crypto']);
const GLOBAL_OBJECTS = ['Math', 'Date', 'performance', 'process', 'console', 'crypto', 'Temporal'];

export interface HygieneViolation {
  readonly file: string;
  readonly line: number;
  readonly token: string;
}

function sourceRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

function collectFiles(root: string, relative: string, out: string[]): void {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) collectFiles(root, path, out);
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
}

function propertyName(node: ts.PropertyName | ts.Expression | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

function memberToken(object: string, property: string): string | undefined {
  const banned = BANNED_OBJECT_MEMBERS.get(object);
  return banned?.has(property) === true || banned?.has('*') === true ? `${object}.${property}` : undefined;
}

/** AST-based so aliases are caught without treating comments and strings as evidence. */
export function scanSourceForBannedEntropy(source: string, file = 'source.ts'): HygieneViolation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const objectAliases = new Map(GLOBAL_OBJECTS.map((name) => [name, name]));
  const forbiddenIdentifiers = new Map<string, string>();
  const importViolations: Array<{ readonly node: ts.Node; readonly token: string }> = [];

  const resolveObject = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression)) return objectAliases.get(expression.text);
    if (ts.isPropertyAccessExpression(expression)) {
      const owner = resolveObject(expression.expression);
      if (owner === 'globalThis' || owner === 'window' || owner === 'self') return objectAliases.get(expression.name.text);
      if (owner === 'crypto' && expression.name.text === 'webcrypto') return 'crypto.webcrypto';
      if (owner === 'Temporal' && expression.name.text === 'Now') return 'Temporal.Now';
    }
    return undefined;
  };

  objectAliases.set('globalThis', 'globalThis');
  objectAliases.set('window', 'window');
  objectAliases.set('self', 'self');

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (CRYPTO_MODULES.has(moduleName)) {
      if (clause.name !== undefined) objectAliases.set(clause.name.text, 'crypto');
      const bindings = clause.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) objectAliases.set(bindings.name.text, 'crypto');
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === 'webcrypto') objectAliases.set(element.name.text, 'crypto.webcrypto');
          const token = memberToken('crypto', imported);
          if (token !== undefined) {
            forbiddenIdentifiers.set(element.name.text, token);
            importViolations.push({ node: element, token });
          }
        }
      }
    }
    if (moduleName === 'node:perf_hooks' && clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === 'performance') {
          objectAliases.set(element.name.text, 'performance');
        }
      }
    }
  }

  const resolveForbidden = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression)) return forbiddenIdentifiers.get(expression.text);
    if (ts.isPropertyAccessExpression(expression)) {
      const owner = resolveObject(expression.expression);
      return owner === undefined ? undefined : memberToken(owner, expression.name.text);
    }
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression !== undefined) {
      const owner = resolveObject(expression.expression);
      const property = propertyName(expression.argumentExpression);
      return owner === undefined || property === undefined ? undefined : memberToken(owner, property);
    }
    return undefined;
  };

  // A short fixed point handles aliases declared before or after another alias
  // without pretending to be a full type checker.
  for (let pass = 0; pass < 3; pass += 1) {
    const visitAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        if (ts.isIdentifier(node.name)) {
          const object = resolveObject(node.initializer);
          if (object !== undefined) objectAliases.set(node.name.text, object);
          const token = resolveForbidden(node.initializer);
          if (token !== undefined) forbiddenIdentifiers.set(node.name.text, token);
        } else if (ts.isObjectBindingPattern(node.name)) {
          const object = resolveObject(node.initializer);
          if (object !== undefined) {
            for (const element of node.name.elements) {
              if (!ts.isIdentifier(element.name)) continue;
              const property = propertyName(element.propertyName) ?? element.name.text;
              const token = memberToken(object, property);
              if (token !== undefined) forbiddenIdentifiers.set(element.name.text, token);
              if (object === 'crypto' && property === 'webcrypto') {
                objectAliases.set(element.name.text, 'crypto.webcrypto');
              }
            }
          }
        }
      }
      ts.forEachChild(node, visitAliases);
    };
    visitAliases(sourceFile);
  }

  const found: HygieneViolation[] = [];
  const record = (node: ts.Node, token: string): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    if (!found.some((violation) => violation.line === line && violation.token === token)) {
      found.push({ file, line, token });
    }
  };
  for (const violation of importViolations) record(violation.node, violation.token);

  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && resolveObject(node.expression) === 'Date') record(node, 'new Date()');
    if (ts.isCallExpression(node)) {
      if (resolveObject(node.expression) === 'Date') record(node, 'Date()');
      const token = resolveForbidden(node.expression);
      if (token !== undefined) record(node, token);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const token = resolveForbidden(node);
      if (token !== undefined) record(node, token);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found.sort((left, right) => left.line - right.line || left.token.localeCompare(right.token));
}

export function scanForBannedEntropy(): HygieneViolation[] {
  const root = sourceRoot();
  const files: string[] = [];
  for (const directory of SCANNED_DIRECTORIES) collectFiles(root, directory, files);
  return files.flatMap((file) =>
    EXEMPT_FILES.includes(file) ? [] : scanSourceForBannedEntropy(readFileSync(join(root, file), 'utf8'), file),
  );
}

export function evaluateHygiene(seed: string): ProbeReport {
  const violations = scanForBannedEntropy();
  const detail =
    violations.length === 0
      ? `${SCANNED_DIRECTORIES.map((directory) => `src/${directory}`).join(', ')} clean; only src/${EXEMPT_FILES[0]} may read a clock`
      : violations.map((violation) => `${violation.file}:${violation.line} ${violation.token}`).join(', ');

  return makeReport({
    probeId: 'P2',
    name: 'Entropy hygiene',
    scenario: 'static',
    seed,
    severity: 'gate',
    value: violations.length,
    threshold: { max: 0, label: 'nondeterministic entropy/clock references = 0' },
    generationsRun: 0,
    detail,
  });
}

export const hygieneProbe: ProbeDefinition = {
  id: 'P2',
  name: 'Entropy hygiene',
  scenario: 'static',
  severity: 'gate',
  standalone: true,
  evaluate(_runs, context) {
    const seed = context.runs[0]?.seed ?? 'static';
    return [evaluateHygiene(seed)];
  },
};
