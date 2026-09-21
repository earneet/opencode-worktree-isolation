// Dual-entry package: OpenCode V2 reads `id` + `setup()` from the default
// export and ignores `server()`; V1 hosts (>= 1.18.29) detect the object form
// and call `server(input, options)`. Both plugin packages are imported
// type-only here so neither host process loads the other generation's
// dependency graph: v2.ts has no runtime opencode imports, and v1.ts is
// loaded lazily inside server().
import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import type { Plugin as PluginNamespace } from "@opencode/plugin"
import { v2Plugin } from "./v2.js"

const entry: PluginNamespace.Plugin & { server: V1Plugin } = {
    ...v2Plugin,
    server: async (input, options) => {
        const { v1Plugin } = await import("./v1.js")
        return v1Plugin(input, options)
    },
}

export default entry
