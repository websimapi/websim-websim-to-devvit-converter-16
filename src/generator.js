import JSZip from 'jszip';
import { 
    cleanName, 
    AssetAnalyzer 
} from './processors.js';

import {
    generatePackageJson,
    generateDevvitYaml,
    generateViteConfig,
    tsConfig,
    getServerIndexTs,
    simpleLoggerJs,
    devvitApiPolyfill,
    websimSocketPolyfill,
    websimStubsJs,
    websimPackageJs,
    jsxDevProxy,
    validateScript,
    setupScript,
    generateReadme
} from './templates.js';

export async function generateDevvitZip(projectMeta, assets, includeReadme = true) {
    const zip = new JSZip();
    
    const safeId = projectMeta.project.id ? projectMeta.project.id.slice(0, 6) : '000000';
    const rawSlug = projectMeta.project.slug || "websim-game";
    const projectSlug = cleanName(`${rawSlug}-${safeId}`);
    const projectTitle = projectMeta.project.title || "WebSim Game";

    // Initialize Analyzer
    const analyzer = new AssetAnalyzer();
    const clientFiles = {};

    // 1. Process Assets for Client Folder
    // We categorize files: JS gets rewritten, HTML gets cleaned, rest copied.
    
    for (const [path, content] of Object.entries(assets)) {
        if (path.includes('..')) continue;

        if (/\.(js|mjs|ts|jsx|tsx)$/i.test(path)) {
            const processed = analyzer.processJS(content, path);
            clientFiles[path] = processed;
        } else if (path.endsWith('.html')) {
            const { html, extractedScripts } = analyzer.processHTML(content, path.split('/').pop());
            clientFiles[path] = html;
            
            // Add extracted inline scripts to client files
            extractedScripts.forEach(script => {
                // Place them relative to the html file
                const parts = path.split('/');
                parts.pop();
                const dir = parts.join('/');
                const fullPath = dir ? `${dir}/${script.filename}` : script.filename;
                clientFiles[fullPath] = script.content;
            });
        } else if (path.endsWith('.css')) {
            clientFiles[path] = analyzer.processCSS(content, path);
        } else {
            // Static assets (images, etc)
            clientFiles[path] = content;
        }
    }

    // Identify Index for Devvit Main.tsx
    let indexPath = 'index.html'; 
    for (const p of Object.keys(clientFiles)) {
        if (p.endsWith('index.html')) {
            indexPath = p;
            break; 
        }
    }

    // 2. Generate Config Files
    // Now that we've analyzed files, analyzer.dependencies is populated
    
    // Configure Vite for React/Remotion if detected
    const hasRemotion = !!analyzer.dependencies['remotion'];
    const hasReact = hasRemotion || !!analyzer.dependencies['react'];

    const extraDevDeps = {};
    if (hasReact) {
        extraDevDeps['@vitejs/plugin-react'] = '^4.2.0';
        // Explicitly needed because we define custom babel config in vite.config.js
        extraDevDeps['@babel/core'] = '^7.23.0';
        extraDevDeps['@babel/preset-react'] = '^7.23.0';
    }

    zip.file("package.json", generatePackageJson(projectSlug, analyzer.dependencies, extraDevDeps));
    zip.file("devvit.yaml", generateDevvitYaml(projectSlug));
    zip.file("vite.config.js", generateViteConfig({ hasReact, hasRemotion }));
    zip.file("tsconfig.json", tsConfig);
    zip.file(".gitignore", "node_modules\n.devvit\nwebroot/assets"); // Ignore build artifacts if needed

    if (includeReadme) {
        zip.file("README.md", generateReadme(projectTitle, `https://websim.ai/p/${projectMeta.project.id}`));
    }

    zip.file("scripts/setup.js", setupScript);
    zip.file("scripts/validate.js", validateScript);

    // 3. Client Folder (Source)
    // Structure: src/client/ for frontend source, src/server/ for Devvit backend
    const clientFolder = zip.folder("src/client");
    const publicFolder = clientFolder.folder("public");

    for (const [path, content] of Object.entries(clientFiles)) {
        if (/\.(html|js|mjs|ts|jsx|tsx|css|scss)$/i.test(path)) {
            clientFolder.file(path, content);
        } else {
            publicFolder.file(path, content);
        }
    }

    // Add Polyfills to Client Source
    clientFolder.file("logger.js", simpleLoggerJs);
    clientFolder.file("devvit_api.js", devvitApiPolyfill);
    clientFolder.file("websim_socket.js", websimSocketPolyfill);
    clientFolder.file("websim_stubs.js", websimStubsJs);
    clientFolder.file("websim_package.js", websimPackageJs);
    clientFolder.file("jsx-dev-proxy.js", jsxDevProxy);

    if (hasRemotion) {
        clientFolder.file("remotion_bridge.js", `
export * from 'remotion';
export { Player } from '@remotion/player';
        `.trim());
    }

    // 4. Server Code (Devvit)
    zip.file("src/server/index.ts", getServerIndexTs(projectTitle, indexPath));
    
    const blob = await zip.generateAsync({ type: "blob" });
    return { blob, filename: `${projectSlug}-devvit.zip` };
}

