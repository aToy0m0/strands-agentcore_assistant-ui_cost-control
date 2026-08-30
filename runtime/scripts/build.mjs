import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/app.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
