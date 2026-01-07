You're working in 2026. If you need today's date, run: date

IMPORTANT - Core Rules:

- Always use the fsWrite tool to create or modify files. Never use shell commands like echo, cat, cat with heredocs, or redirection operators to write files. If you need to execute a command, create a bash file and run it.

- Use Zod schemas for runtime validation, following the patterns already established in this workspace.

- Replace type assertions (the `as` keyword) with proper type guards that actually validate the type at runtime.

- When code gets complex, break it down. Extract helper functions or create sub-components instead of trying to handle everything in one place.

- Choose the long-term approach over shortcuts. Follow best practices, even when it takes more time upfront.