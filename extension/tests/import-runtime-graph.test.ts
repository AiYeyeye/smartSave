// @vitest-environment node
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

/** Inspect emitted runtime imports, not erased types or the separate Worker URL asset. */
function runtimeGraph(entry: string): Set<string> {
  const visited = new Set<string>();
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
    }).outputText;
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const dependency = (specifier: string) => {
      if (!specifier.startsWith('.')) {
        visited.add(specifier);
        return;
      }
      const base = resolve(dirname(file), specifier);
      const target = [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')].find(existsSync);
      if (!target) throw Error(`Unresolved runtime dependency: ${file} -> ${specifier}`);
      visit(target);
    };
    const walk = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        dependency(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const argument = node.arguments[0];
        if (!argument || !ts.isStringLiteral(argument)) throw Error('Unresolved dynamic runtime dependency');
        dependency(argument.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  visit(resolve(entry));
  return visited;
}

it.each(['import/worker-client.ts', 'domain/import-pipeline.ts'])(
  '%s runtime graph excludes parser implementation and Worker entry',
  entry => {
    const graph = runtimeGraph(entry);
    expect(
      [...graph].filter(path =>
        /(?:parse5|mdast-util-from-markdown|jsonc-parser|[/\\]parsers\.ts$|[/\\]parse-worker\.ts$)/.test(path),
      ),
    ).toEqual([]);
    expect(graph.has(resolve('import/contracts.ts'))).toBe(true);
  },
);

it('graph inspection sees parser dependencies behind the actual Worker entry', () => {
  const graph = runtimeGraph('import/parse-worker.ts');
  for (const dependency of ['parse5', 'mdast-util-from-markdown', 'jsonc-parser', resolve('import/parsers.ts')])
    expect(graph.has(dependency)).toBe(true);
});
