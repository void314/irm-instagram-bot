import * as v from 'valibot'

export const instagramProfileResponse200 = v.object({
    status: v.literal('ok'),
    data: v.object({
        id: v.string(),
        username: v.string()
    })
})

export const instagramProfileResponse400 = v.object({
    status: v.literal('error'),
    message: v.string()
})

export type InstagramProfileResponse200 = v.InferOutput<typeof instagramProfileResponse200>
export type InstagramProfileResponse400 = v.InferOutput<typeof instagramProfileResponse400>
