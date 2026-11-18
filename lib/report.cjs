// Sums app.asar contents per package, to see what takes the space.
"use strict";
const path = require("node:path");

/** @returns {{ name: string, packed: number, unpacked: number }[]} Largest first */
const asarSizes = (asarFile, projectRoot = process.cwd()) => {
    const asar = require(require.resolve("@electron/asar", { paths: [projectRoot, __dirname] }));
    const { header } = asar.getRawHeader(path.resolve(asarFile));
    const totals = new Map();
    const walk = (node, parts) => {
        for (const [name, child] of Object.entries(node.files ?? {})) {
            const segments = [...parts, name];
            if (child.files) {
                walk(child, segments);
                continue;
            }
            const key =
                segments[0] === "node_modules"
                    ? segments.slice(0, segments[1].startsWith("@") ? 3 : 2).join("/")
                    : segments[0];
            const total = totals.get(key) ?? { name: key, packed: 0, unpacked: 0 };
            if (child.unpacked) total.unpacked += child.size ?? 0;
            else total.packed += child.size ?? 0;
            totals.set(key, total);
        }
    };
    walk(header, []);
    return [...totals.values()].sort((a, b) => b.packed + b.unpacked - (a.packed + a.unpacked));
};

module.exports = { asarSizes };
