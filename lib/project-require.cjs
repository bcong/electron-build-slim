// Loads the project's electron-builder and its dependencies (app-builder-lib, @electron/asar).
// With pnpm's default isolated layout, electron-builder's dependencies are not visible from the project root,
// so the real folders of electron-builder and app-builder-lib are searched too.
"use strict";
const path = require("node:path");

const searchPaths = (root) => {
    const paths = [root];
    try {
        const builder = path.dirname(require.resolve("electron-builder/package.json", { paths: [root] }));
        paths.push(builder, path.dirname(require.resolve("app-builder-lib/package.json", { paths: [builder] })));
    } catch {}
    return paths;
};

const requireFromProject = (root, id, extra = []) =>
    require(require.resolve(id, { paths: [...searchPaths(root), ...extra] }));

module.exports = { requireFromProject };
