import * as v from 'valibot'

export const healthResponse200 = v.object({
    status: v.literal('online')
})

export const healthResponse400 = v.object({
    status: v.literal('error'),
    message: v.string()
})

export type HealthResponse200 = v.InferOutput<typeof healthResponse200>
export type HealthResponse400 = v.InferOutput<typeof healthResponse400>
