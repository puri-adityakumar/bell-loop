# Benchmark index site

This directory is the static catalog for the `index` branch.

Publish this directory as the GitHub Pages source with:

- Branch: `index`
- Folder: `/benchmark/site`

`catalog.json` is generated from result branch READMEs with:

```bash
npm run benchmark:catalog
```

The site is intentionally dependency-free. It uses the catalog JSON at runtime and does not need a build step.
