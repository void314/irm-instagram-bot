import * as v from 'valibot'

export const healthResponse200 = v.object({
    status: v.literal('online'),
    message: v.optional(v.string()),
    data: v.optional(v.nullable(v.object({ ok: v.literal(1) })))
})

export const healthResponse500 = v.object({
    status: v.literal('error'),
    message: v.string()
})

export type HealthResponse200 = v.InferOutput<typeof healthResponse200>
export type HealthResponse500 = v.InferOutput<typeof healthResponse500>
