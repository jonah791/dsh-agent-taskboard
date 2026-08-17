import { defineConfig } from 'tsdown'
const PLATFORM_MODULES = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-web-react', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-attachment', '@deepseek-ai/dsh-client-schema-form']
export default defineConfig({
  name: 'dsh-agent-taskboard/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [...PLATFORM_MODULES],
    alwaysBundle: (id) => !PLATFORM_MODULES.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-agent-taskboard", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
