import { tool, type Plugin } from "@opencode-ai/plugin"
import { createCore, DESCRIPTIONS, ARG_DESCRIPTIONS } from "./core.js"
import type { CoreCall } from "./core.js"

const z = tool.schema

export const v1Plugin: Plugin = async (ctx) => {
    const core = createCore({
        repoRoot: ctx.directory,
        getParentId: async (sid) => {
            try {
                const res = await ctx.client.session.get({ path: { id: sid } })
                return res.data?.parentID ?? undefined
            } catch {
                return undefined
            }
        },
    })

    const makeCall = (tctx: { directory: string; sessionID: string; metadata?: (meta: Record<string, unknown>) => void }): CoreCall => {
        const metadata = tctx.metadata
        return {
            sessionId: tctx.sessionID,
            directory: tctx.directory,
            setSessionTitle: metadata ? (title, meta) => metadata({ title, metadata: meta }) : undefined,
        }
    }

    return {
        tool: {
            worktree_prepare: tool({
                description: DESCRIPTIONS.prepare,
                args: {
                    title: z.string().min(1).describe(ARG_DESCRIPTIONS.prepare.title),
                    branch: z.string().optional().describe(ARG_DESCRIPTIONS.prepare.branch),
                    baseBranch: z.string().optional().describe(ARG_DESCRIPTIONS.prepare.baseBranch),
                },
                execute: (args, tctx) => core.prepare(args, makeCall(tctx)),
            }),

            worktree_cleanup: tool({
                description: DESCRIPTIONS.cleanup,
                args: {
                    action: z.enum(["preview", "apply"]).describe(ARG_DESCRIPTIONS.cleanup.action),
                    branch: z.string().optional().describe(ARG_DESCRIPTIONS.cleanup.branch),
                    force: z.boolean().optional().describe(ARG_DESCRIPTIONS.cleanup.force),
                },
                execute: (args, tctx) => core.cleanup(args, makeCall(tctx)),
            }),

            worktree_merge: tool({
                description: DESCRIPTIONS.merge,
                args: {
                    action: z.enum(["preview", "apply"]).describe(ARG_DESCRIPTIONS.merge.action),
                    branch: z.string().optional().describe(ARG_DESCRIPTIONS.merge.branch),
                },
                execute: (args, tctx) => core.merge(args, makeCall(tctx)),
            }),

            worktree_allow: tool({
                description: DESCRIPTIONS.allow,
                args: {
                    action: z.enum(["add", "list", "clear"]).describe(ARG_DESCRIPTIONS.allow.action),
                    path: z.string().optional().describe(ARG_DESCRIPTIONS.allow.path),
                    reason: z.string().optional().describe(ARG_DESCRIPTIONS.allow.reason),
                    ttlMinutes: z.number().optional().describe(ARG_DESCRIPTIONS.allow.ttlMinutes),
                },
                execute: (args, tctx) => core.allow(args, makeCall(tctx)),
            }),
        },

        event: async ({ event }) => {
            if (event.type === "session.idle") {
                core.onSessionIdle(event.properties.sessionID)
                return
            }
            if (event.type === "session.deleted") {
                const sid = event.properties.info.id
                if (sid) core.onSessionDeleted(sid)
            }
        },

        "tool.execute.before": async (input, output) => {
            await core.intercept(input?.tool, input?.sessionID, output?.args, input?.callID)
        },

        "tool.execute.after": async (input, output) => {
            const notice = core.takeShellRewriteNotice(input?.callID ?? "")
            if (!notice || !output || typeof output.output !== "string") return
            output.output = notice + output.output
        },

        "experimental.chat.system.transform": async (input, output) => {
            if (!output || !Array.isArray(output.system)) return
            const text = await core.systemPromptText(input?.sessionID)
            if (text) output.system.push(text)
        },
    }
}
