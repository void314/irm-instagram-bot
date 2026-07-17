import * as v from 'valibot'

export const userTokenBody = v.object({
    userToken: v.string()
})

export const tokenFromUserResponse200 = v.object({
    page: v.object({
        id: v.string(),
        name: v.string()
    }),
    pageAccessToken: v.string(),
    note: v.optional(v.string()),
    warning: v.optional(v.string())
})

export const tokenFromUserErrorResponse400 = v.object({
    error: v.string(),
    details: v.optional(v.unknown()),
    me: v.optional(v.unknown()),
    permissions: v.optional(v.array(v.string())),
    hint: v.optional(v.string()),
    availablePages: v.optional(
        v.array(
            v.object({
                id: v.string(),
                name: v.string()
            })
        )
    )
})

export const oauthCallbackResponse200 = v.object({
    success: v.literal(true),
    message: v.string()
})

export const oauthCallbackErrorResponse400 = v.object({
    error: v.string(),
    error_description: v.optional(v.string()),
    details: v.optional(v.unknown())
})
