import * as v from 'valibot'

export const facebookLoginQuery = v.object({
    redirect_uri: v.optional(v.string())
})

export const facebookCallbackQuery = v.object({
    code: v.optional(v.string()),
    redirect_uri: v.optional(v.string()),
    error_description: v.optional(v.string())
})

export const userTokenBody = v.object({
    userToken: v.string()
})

export const tokenFromUserResponse200 = v.object({
    user: v.optional(v.unknown()),
    page: v.object({
        id: v.string(),
        name: v.string()
    }),
    pageAccessToken: v.string(),
    igBusinessAccount: v.optional(
        v.object({
            igId: v.string(),
            username: v.optional(v.string())
        })
    ),
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

export type FacebookLoginQuery = v.InferOutput<typeof facebookLoginQuery>
export type FacebookCallbackQuery = v.InferOutput<typeof facebookCallbackQuery>
export type TokenFromUserResponse200 = v.InferOutput<typeof tokenFromUserResponse200>
export type TokenFromUserErrorResponse400 = v.InferOutput<typeof tokenFromUserErrorResponse400>
export type OauthCallbackResponse200 = v.InferOutput<typeof oauthCallbackResponse200>
export type OauthCallbackErrorResponse400 = v.InferOutput<typeof oauthCallbackErrorResponse400>
