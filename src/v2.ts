// No runtime import of "@opencode/plugin": Plugin.define is an identity
// function, and keeping V2 hosts from loading the V1 package (and vice versa)
// matters more than calling define(). The definition below is type-checked
// against the same interface define() would return.
import type { Plugin as PluginNamespace } from "@opencode/plugin"
import { createCore, DESCRIPTIONS, ARG_DESCRIPTIONS } from "./core.js"
import { injectShellRewriteNotice } from "./lib.js"
import type { AllowArgs, CleanupArgs, CoreCall, MergeArgs, PrepareArgs } from "./core.js"

const PREPARE_INPUT = {
    type: "object",
    properties: {
        title: { type: "string", minLength: 1, description: ARG_DESCRIPTIONS.prepare.title },
        branch: { type: "string", description: ARG_DESCRIPTIONS.prepare.branch },
        baseBranch: { type: "string", description: ARG_DESCRIPTIONS.prepare.baseBranch },
    },
    required: ["title"],
    additionalProperties: false,
}

const CLEANUP_INPUT = {
    type: "object",
    properties: {
        action: { type: "string", enum: ["preview", "apply"], description: ARG_DESCRIPTIONS.cleanup.action },
        branch: { type: "string", description: ARG_DESCRIPTIONS.cleanup.branch },
        force: { type: "boolean", description: ARG_DESCRIPTIONS.cleanup.force },
    },
    required: ["action"],
    additionalProperties: false,
}

const MERGE_INPUT = {
    type: "object",
    properties: {
        action: { type: "string", enum: ["preview", "apply"], description: ARG_DESCRIPTIONS.merge.action },
        branch: { type: "string", description: ARG_DESCRIPTIONS.merge.branch },
    },
    required: ["action"],
    additionalProperties: false,
}

const ALLOW_INPUT = {
    type: "object",
    properties: {
        action: { type: "string", enum: ["add", "list", "clear"], description: ARG_DESCRIPTIONS.allow.action },
        path: { type: "string", description: ARG_DESCRIPTIONS.allow.path },
        reason: { type: "string", description: ARG_DESCRIPTIONS.allow.reason },
        ttlMinutes: { type: "number", description: ARG_DESCRIPTIONS.allow.ttlMinutes },
    },
    required: ["action"],
    additionalProperties: false,
}

export const v2Plugin: PluginNamespace.Plugin = {
    id: "worktree-isolation",
    async setup(ctx) {
        const repoRoot = ctx.location.directory
        const core = createCore({
            repoRoot,
            getParentId: async (sid) => {
                try {
                    const session = await ctx.session.get({ sessionID: sid })
                    return session?.parentID ?? undefined
                } catch {
                    return undefined
                }
            },
        })

        // V2 has no per-call directory on tool executors, so every tool call is
        // anchored to the location this plugin instance was loaded for.
        const makeCall = (sessionId: string): CoreCall => ({
            sessionId,
            directory: repoRoot,
            // 2.0.11 exposes session title updates via session.update; the docs
            // site already shows a "rename" method that this version does not
            // ship. Revisit when bumping @opencode/plugin.
            setSessionTitle: (title) => {
                void ctx.session.update({ sessionID: sessionId, title }).catch(() => {})
            },
        })

        await ctx.tool.transform((editor) => {
            editor.add({
                name: "worktree_prepare",
                description: DESCRIPTIONS.prepare,
                input: PREPARE_INPUT,
                execute: async (input, context) => ({
                    content: await core.prepare(input as PrepareArgs, makeCall(context.sessionID)),
                }),
            })
            editor.add({
                name: "worktree_cleanup",
                description: DESCRIPTIONS.cleanup,
                input: CLEANUP_INPUT,
                execute: async (input, context) => ({
                    content: await core.cleanup(input as CleanupArgs, makeCall(context.sessionID)),
                }),
            })
            editor.add({
                name: "worktree_merge",
                description: DESCRIPTIONS.merge,
                input: MERGE_INPUT,
                execute: async (input, context) => ({
                    content: await core.merge(input as MergeArgs, makeCall(context.sessionID)),
                }),
            })
            editor.add({
                name: "worktree_allow",
                description: DESCRIPTIONS.allow,
                input: ALLOW_INPUT,
                execute: async (input, context) => ({
                    content: await core.allow(input as AllowArgs, makeCall(context.sessionID)),
                }),
            })
        })

        await ctx.tool.hook("execute.before", async (event) => {
            await core.intercept(event.tool, event.sessionID, event.input, event.id)
        })

        await ctx.tool.hook("execute.after", async (event) => {
            if (event.status !== "completed") {
                core.takeShellRewriteNotice(event.id)
                return
            }
            const notice = core.takeShellRewriteNotice(event.id)
            if (notice) injectShellRewriteNotice(event.result, notice)
        })

        await ctx.session.hook("context", async (event) => {
            const text = await core.systemPromptText(event.sessionID)
            if (text) event.system.push({ type: "text", text })
        })

        const controller = new AbortController()
        void (async () => {
            for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
                // The public event stream is server-wide; V1 hosts filtered by
                // location before delivery, so keep that behavior here.
                if (event.location?.directory && event.location.directory !== repoRoot) continue
                if (event.type === "session.idle") {
                    core.onSessionIdle(event.data.sessionID)
                } else if (event.type === "session.deleted") {
                    core.onSessionDeleted(event.data.sessionID)
                }
            }
        })().catch(() => {})

        return () => controller.abort()
    },
}
