export const generatePackageJson = (slug, dependencies = {}, devDependencies = {}) => JSON.stringify({
  "name": slug,
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/server/main.tsx",
  "scripts": {
    "dev": "devvit playtest",
    "build:client": "vite build",
    "setup": "node scripts/setup.js",
    "register": "devvit upload",
    "upload": "devvit upload",
    "validate": "node scripts/validate.js"
  },
  "dependencies": {
    "@devvit/public-api": "latest",
    "@devvit/kit": "latest",
    "@devvit/web": "latest",
    ...dependencies
  },
  "devDependencies": {
    "devvit": "latest",
    "typescript": "^5.0.0",
    "vite": "^5.0.0",
    "terser": "^5.19.0",
    ...devDependencies
  }
}, null, 2);

export const generateDevvitYaml = (slug) => `name: ${slug}
version: 0.1.0
webroot: webroot
`;

export const generateViteConfig = ({ hasReact = false, hasRemotion = false } = {}) => `
import { defineConfig } from 'vite';
import path from 'path';
${hasReact ? "import react from '@vitejs/plugin-react';" : ''}

export default defineConfig({
  mode: 'production',
  root: 'src/client',
  base: './',
  plugins: [
    ${hasReact ? `react({
      jsxRuntime: 'automatic',
      jsxImportSource: 'react',
      include: "**/*.{jsx,tsx,js,ts}",
      babel: {
        babelrc: false,
        configFile: false,
        plugins: []
      }
    }),` : ''}
  ],
  resolve: {
    alias: {
      'react/jsx-dev-runtime': path.resolve(__dirname, 'src/client/jsx-dev-proxy.js'),
      'react/jsx-runtime': 'react/jsx-runtime',
      ${hasRemotion ? "'remotion': 'remotion'," : ''}
      'websim': path.resolve(__dirname, 'src/client/websim_package.js')
    },
    mainFields: ['browser', 'module', 'main'],
  },
  assetsInclude: ['**/*.mp3', '**/*.wav', '**/*.ogg', '**/*.glb', '**/*.gltf', '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif'],
  build: {
    outDir: '../../webroot',
    emptyOutDir: true,
    target: 'es2020',
    minify: 'esbuild',
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "process.platform": JSON.stringify("browser"),
    ${hasRemotion ? '"process.env.REMOTION_ENV": JSON.stringify("production"),' : ''}
  },
  optimizeDeps: {
    include: [${hasReact ? "'react', 'react-dom', 'react/jsx-runtime'" : ""}${hasRemotion ? ", 'remotion', '@remotion/player'" : ""}]
  }
});
`;

export const tsConfig = JSON.stringify({
  "compilerOptions": {
    "target": "es2020",
    "module": "es2020",
    "moduleResolution": "node",
    "lib": ["es2020", "dom"],
    "jsx": "react",
    "jsxFactory": "Devvit.createElement",
    "jsxFragmentFactory": "Devvit.Fragment",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "noImplicitAny": false
  },
  "include": [
    "src/**/*",
    "client/**/*"
  ]
}, null, 2);

