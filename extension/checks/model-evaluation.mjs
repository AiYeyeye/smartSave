import { build } from 'vite';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv from 'ajv';

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
if ((!option('--dataset') || !option('--config')) && !option('--from-export')) {
  console.log(
    'Usage: node checks/model-evaluation.mjs --dataset <local-labeled.json> --config <model-routes.json> [--run] [--output <report.json>]\nTemplate: --from-export <zhilan-export.json> --output <local-template.json>\nDefault: validate only, zero model requests. See docs/model-evaluation.md.',
  );
  process.exitCode = 1;
} else {
  const outDir = await mkdtemp(join(tmpdir(), 'zhilan-model-evaluation-'));
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      target: 'es2022',
      lib: { entry: resolve('checks/model-evaluation-runner.ts'), formats: ['es'], fileName: () => 'run.mjs' },
    },
  });
  const { evaluationDatasetSchema, evaluationRouteSchema, prepareEvaluation, evaluateModel, evaluationTemplate } =
    await import(pathToFileURL(join(outDir, 'run.mjs')).href);
  if (option('--from-export')) {
    if (!option('--output')) throw Error('Template output path required');
    const text = await readFile(option('--from-export'), 'utf8');
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw Error('Export exceeds 16MiB');
    const document = JSON.parse(text);
    const schema = JSON.parse(await readFile(resolve('export/json-schema.json'), 'utf8'));
    if (!new Ajv({ allErrors: true }).validate(schema, document)) throw Error('Invalid Zhilan public export v1');
    const template = evaluationTemplate(document);
    await writeFile(option('--output'), `${JSON.stringify(template, null, 2)}\n`);
    console.log(
      JSON.stringify({
        template: true,
        casesToLabel: template.cases.length,
        providerRequests: 0,
        notice: 'Fill expectedFolderId manually; current placement is not a ground-truth label.',
      }),
    );
  } else {
    const dataset = evaluationDatasetSchema.parse(JSON.parse(await readFile(option('--dataset'), 'utf8')));
    const rawRoutes = JSON.parse(await readFile(option('--config'), 'utf8'));
    const routes = (Array.isArray(rawRoutes) ? rawRoutes : [rawRoutes]).map(route =>
      evaluationRouteSchema.parse(route),
    );
    if (!routes.length || routes.length > 20) throw Error('Expected 1–20 model routes');
    const prepared = prepareEvaluation(dataset);
    if (!args.includes('--run')) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            dataset: dataset.name,
            cases: prepared.length,
            models: routes.map(route => route.config.model),
            expectedOutsideCandidates: prepared.filter(sample => !sample.expectedInCandidates).length,
            providerRequests: 0,
          },
          null,
          2,
        ),
      );
    } else {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel);
      const reports = [];
      try {
        // Validate all credentials before sending anything. Keys never enter files or reports.
        const keys = routes.map(route => {
          const key = process.env[route.keyEnv ?? 'ZHILAN_EVAL_API_KEY'] ?? '';
          const host = new URL(route.config.baseUrl).hostname;
          if (!key && !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(host))
            throw Error(`Missing key environment variable: ${route.keyEnv ?? 'ZHILAN_EVAL_API_KEY'}`);
          return key;
        });
        for (let i = 0; i < routes.length && !controller.signal.aborted; i++)
          reports.push(await evaluateModel(dataset, routes[i].config, keys[i], { signal: controller.signal }));
      } finally {
        process.removeListener('SIGINT', cancel);
      }
      const output = JSON.stringify(reports, null, 2);
      if (option('--output')) await writeFile(option('--output'), `${output}\n`);
      console.log(output);
      if (controller.signal.aborted) process.exitCode = 130;
    }
  }
}
