import { configDefaults, defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths({ projects: ['./tsconfig.typecheck.json'] })],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Nested git worktrees are full copies of the repo with their own specs.
    exclude: [...configDefaults.exclude, '.claude/worktrees/**'],
  },
});
