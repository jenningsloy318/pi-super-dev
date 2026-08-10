# Repository Instructions

- After every fix or feature implementation that changes this extension, bump the runtime extension version in `src/version.ts` before committing. Runtime versions use npm-valid semver without leading zeroes. Patch values run from `1` to `99`; after patch `99`, bump minor and reset patch to `1`; after minor `99`, bump major and reset minor and patch to `1`.
- In the same commit, align `package.json` and `package-lock.json` to the exact same version as `src/version.ts`.
- Include all version bumps in the same commit as the fix or feature.
- For deep online research in this repository, try search tools in this order: AnySearch first, then Firecrawl MCP/CLI, then Tavily remote MCP, then Tinyfish.
