Always delegate codebase exploration (directory structure, package layout, understanding dependencies, finding files/routes) to the codebase-explorer subagent by using `task` with `subagent_type: "codebase-explorer"`.

Never directly modify dependencies and packages. Always run `bun install` or `bun remove`

After each code change, run `bun run check` from the project root. Use only the repository’s configured formatter (currently oxfmt); never run or introduce another formatter such as Prettier.