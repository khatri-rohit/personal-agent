import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: [
      '**/dist',
      '**/dist-cli',
      '**/.next',
      '**/next-env.d.ts',
      '**/vite.config.*.timestamp*',
      '**/vitest.config.*.timestamp*',
      '**/test-output',
      '**/out-tsc',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          // Tiers from docs/adr/0003 §8: data ← engine ← service ← adapter ← app;
          // client depends on data only; a UI sees only data + client.
          // `runtime:core` marks the agent runtime the eval app must never import.
          depConstraints: [
            {
              sourceTag: 'type:data',
              onlyDependOnLibsWithTags: ['type:data'],
            },
            {
              sourceTag: 'type:client',
              onlyDependOnLibsWithTags: ['type:data'],
            },
            {
              sourceTag: 'type:engine',
              onlyDependOnLibsWithTags: ['type:data'],
            },
            {
              sourceTag: 'type:service',
              onlyDependOnLibsWithTags: ['type:data', 'type:engine'],
            },
            {
              sourceTag: 'type:adapter',
              onlyDependOnLibsWithTags: ['type:data', 'type:engine', 'type:service'],
            },
            {
              sourceTag: 'type:ui',
              onlyDependOnLibsWithTags: ['type:data', 'type:client'],
            },
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: ['type:data', 'type:client', 'type:engine', 'type:service', 'type:adapter'],
            },
            {
              sourceTag: 'scope:web',
              onlyDependOnLibsWithTags: ['type:data', 'type:client'],
            },
            {
              sourceTag: 'scope:eval',
              notDependOnLibsWithTags: ['runtime:core'],
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    // Override or add rules here
    rules: {},
  },
];
