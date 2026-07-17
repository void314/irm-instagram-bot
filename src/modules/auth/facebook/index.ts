import Elysia from 'elysia'

import { env } from '../../../config/constants'
import {
    oauthCallbackErrorResponse400,
    oauthCallbackResponse200,
    subscribeErrorResponse400,
    subscribeResponse200,
    tokenFromUserErrorResponse400,
    tokenFromUserResponse200,
    userTokenBody
} from './model'

const FB_AUTH_URL = 'https://www.facebook.com/v25.0/dialog/oauth'
const FB_TOKEN_URL = 'https://graph.facebook.com/v25.0/oauth/access_token'
const FB_GRAPH_URL = 'https://graph.facebook.com/v25.0'

async function graphApiGet(path: string, token: string) {
    const url = new URL(`${FB_GRAPH_URL}${path}`)
    url.searchParams.set('access_token', token)
    try {
        const res = await fetch(url)
        return { ok: res.ok, data: await res.json() }
    } catch (e) {
        return { ok: false, data: String(e) }
    }
}

const SCOPES = [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_metadata',
    'pages_messaging',
    'instagram_basic',
    'instagram_manage_messages',
    'instagram_manage_comments',
    'public_profile'
].join(',')

export const authController = new Elysia({ prefix: '/auth/facebook', detail: { tags: ['Auth'] } })
    .get(
        '/login',
        ({ query, set }) => {
            const redirectUri = query.redirect_uri || `http://localhost:${env.PORT}/api/auth/facebook/callback`

            if (!env.FACEBOOK_APP_ID) {
                set.status = 400
                return { error: 'FACEBOOK_APP_ID not configured' }
            }

            const fbUrl = new URL(FB_AUTH_URL)
            fbUrl.searchParams.set('client_id', env.FACEBOOK_APP_ID)
            fbUrl.searchParams.set('redirect_uri', redirectUri)
            fbUrl.searchParams.set('scope', SCOPES)
            fbUrl.searchParams.set('response_type', 'code')

            set.redirect = fbUrl.toString()
            return
        },
        {
            detail: {
                summary: 'Facebook OAuth login',
                description: 'Redirect to Facebook OAuth dialog to obtain user permissions'
            }
        }
    )
    .post(
        '/token-from-user',
        async ({ body, set }) => {
            const { userToken } = body as { userToken?: string }

            if (!userToken) {
                set.status = 400
                return { error: 'Missing userToken' }
            }

            const meRes = await graphApiGet('/me', userToken)
            if (!meRes.ok) {
                set.status = 400
                return { error: 'Invalid user token', details: meRes.data }
            }

            const permsRes = await graphApiGet('/me/permissions', userToken)
            const perms = (permsRes.data as { data?: Array<{ permission: string; status: string }> })?.data || []

            const pagesRes = await graphApiGet('/me/accounts', userToken)
            const pagesData = pagesRes.data as {
                data?: Array<{ id: string; name: string; access_token: string }>
            }

            if (!pagesRes.ok) {
                set.status = 400
                return { error: 'Cannot get pages', details: pagesData }
            }

            const pages = pagesData?.data || []
            const grantedPerms = perms.filter((p) => p.status === 'granted').map((p) => p.permission)
            const hasPagesMessaging = grantedPerms.includes('pages_messaging')

            if (pages.length === 0 && env.FACEBOOK_PAGE_ID) {
                const directRes = await graphApiGet(`/${env.FACEBOOK_PAGE_ID}?fields=access_token,name`, userToken)
                if (directRes.ok && (directRes.data as { access_token?: string })?.access_token) {
                    const d = directRes.data as { access_token: string; name: string; id: string }
                    const result: Record<string, unknown> = {
                        page: { id: d.id, name: d.name },
                        pageAccessToken: d.access_token,
                        note: 'Token obtained via direct page access (Business Portfolio)'
                    }
                    if (!hasPagesMessaging) {
                        result.warning =
                            'Missing pages_messaging — subscription will fail. Regenerate token with this permission'
                    }
                    return result
                }
            }

            if (pages.length === 0) {
                return {
                    error: 'No pages found and direct access failed',
                    me: meRes.data,
                    permissions: grantedPerms,
                    hint: 'Make sure the page exists and you are its admin'
                }
            }

            const matchedPage = env.FACEBOOK_PAGE_ID ? pages.find((p) => p.id === env.FACEBOOK_PAGE_ID) : pages[0]

            if (!matchedPage) {
                return {
                    error: `Page ${env.FACEBOOK_PAGE_ID} not found in user's pages`,
                    me: meRes.data,
                    availablePages: pages.map((p) => ({ id: p.id, name: p.name }))
                }
            }

            const result: Record<string, unknown> = {
                user: meRes.data,
                page: { id: matchedPage.id, name: matchedPage.name },
                pageAccessToken: matchedPage.access_token
            }
            if (!hasPagesMessaging) {
                result.warning =
                    'Missing pages_messaging — subscription will fail. Regenerate token with this permission'
            }
            return result
        },
        {
            body: userTokenBody,
            response: {
                200: tokenFromUserResponse200,
                400: tokenFromUserErrorResponse400
            },
            detail: {
                summary: 'Exchange user token for page access token',
                description:
                    'Takes a Facebook User Access Token and returns the Page Access Token for the configured page. Useful for debugging and initial setup.'
            }
        }
    )
    .get(
        '/callback',
        async ({ query, set }) => {
            const code = query.code
            const redirectUri = query.redirect_uri || `http://localhost:${env.PORT}/api/auth/facebook/callback`

            if (!code) {
                set.status = 400
                return { error: 'Missing code parameter', error_description: query.error_description }
            }

            if (!env.FACEBOOK_APP_ID || !env.FACEBOOK_APP_SECRET) {
                set.status = 400
                return {
                    error: 'FACEBOOK_APP_ID or FACEBOOK_APP_SECRET not configured'
                }
            }

            const tokenUrl = new URL(FB_TOKEN_URL)
            tokenUrl.searchParams.set('client_id', env.FACEBOOK_APP_ID)
            tokenUrl.searchParams.set('client_secret', env.FACEBOOK_APP_SECRET)
            tokenUrl.searchParams.set('redirect_uri', redirectUri)
            tokenUrl.searchParams.set('code', code)

            const tokenRes = await fetch(tokenUrl)
            const tokenData = (await tokenRes.json()) as {
                access_token?: string
                error?: { message?: string }
            }

            if (!tokenRes.ok || !tokenData.access_token) {
                set.status = 400
                return { error: 'Token exchange failed', details: tokenData.error }
            }

            return { success: true as const, message: 'OAuth completed' }
        },
        {
            response: {
                200: oauthCallbackResponse200,
                400: oauthCallbackErrorResponse400
            },
            detail: {
                summary: 'Facebook OAuth callback',
                description: 'Handles the OAuth redirect from Facebook, exchanges the code for an access token'
            }
        }
    )
