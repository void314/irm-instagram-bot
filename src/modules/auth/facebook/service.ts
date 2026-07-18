import { status } from 'elysia'

import { env } from '../../../config/constants'
import type {
    OauthCallbackErrorResponse400,
    OauthCallbackResponse200,
    TokenFromUserErrorResponse400,
    TokenFromUserResponse200
} from './model'

const FB_AUTH_URL = 'https://www.facebook.com/v25.0/dialog/oauth'
const FB_TOKEN_URL = 'https://graph.facebook.com/v25.0/oauth/access_token'
const FB_GRAPH_URL = 'https://graph.facebook.com/v25.0'

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

type GraphApiResponse =
    | {
          ok: true
          data: unknown
      }
    | {
          ok: false
          data: unknown
      }

type FacebookPage = {
    id: string
    name: string
    access_token: string
}

type FacebookPermission = {
    permission: string
    status: string
}

type IgBusinessAccount = {
    id: string
    username?: string
}

export class FacebookAuthService {
    public getCallbackUrl(redirectUri?: string) {
        return redirectUri || `http://localhost:${env.PORT}/api/auth/facebook/callback`
    }

    public getLoginRedirectUrl(redirectUri?: string) {
        const fbUrl = new URL(FB_AUTH_URL)

        fbUrl.searchParams.set('client_id', env.FACEBOOK_APP_ID!)
        fbUrl.searchParams.set('redirect_uri', this.getCallbackUrl(redirectUri))
        fbUrl.searchParams.set('scope', SCOPES)
        fbUrl.searchParams.set('response_type', 'code')

        return fbUrl.toString()
    }

    private async fetchIgBusinessAccount(
        pageId: string,
        pageAccessToken: string
    ): Promise<{ igId: string; username?: string } | null> {
        const res = await this.graphApiGet(
            `/${pageId}?fields=instagram_business_account{id,username}`,
            pageAccessToken
        )

        if (!res.ok) return null

        const data = res.data as {
            instagram_business_account?: IgBusinessAccount
        }

        if (!data.instagram_business_account) return null

        return {
            igId: data.instagram_business_account.id,
            username: data.instagram_business_account.username
        }
    }

    public async exchangeUserToken(
        userToken: string
    ): Promise<TokenFromUserResponse200 | TokenFromUserErrorResponse400> {
        const meRes = await this.graphApiGet('/me', userToken)
        if (!meRes.ok) {
            return { error: 'Invalid user token', details: meRes.data }
        }

        const permsRes = await this.graphApiGet('/me/permissions', userToken)
        const perms = (permsRes.data as { data?: FacebookPermission[] })?.data || []

        const pagesRes = await this.graphApiGet('/me/accounts', userToken)
        const pagesData = pagesRes.data as { data?: FacebookPage[] }

        if (!pagesRes.ok) {
            return { error: 'Cannot get pages', details: pagesData }
        }

        const pages = pagesData?.data || []
        const grantedPerms = perms
            .filter((permission) => permission.status === 'granted')
            .map((permission) => permission.permission)
        const hasPagesMessaging = grantedPerms.includes('pages_messaging')

        if (pages.length === 0 && env.FACEBOOK_PAGE_ID) {
            const directRes = await this.graphApiGet(
                `/${env.FACEBOOK_PAGE_ID}?fields=access_token,name`,
                userToken
            )

            if (directRes.ok && (directRes.data as { access_token?: string })?.access_token) {
                const page = directRes.data as FacebookPage
                const ig = await this.fetchIgBusinessAccount(page.id, page.access_token)

                const result: TokenFromUserResponse200 = {
                    page: { id: page.id, name: page.name },
                    pageAccessToken: page.access_token,
                    note: 'Token obtained via direct page access (Business Portfolio)'
                }

                if (ig) {
                    result.igBusinessAccount = { igId: ig.igId, username: ig.username }
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

        const matchedPage = env.FACEBOOK_PAGE_ID
            ? pages.find((page) => page.id === env.FACEBOOK_PAGE_ID)
            : pages[0]

        if (!matchedPage) {
            return {
                error: `Page ${env.FACEBOOK_PAGE_ID} not found in user's pages`,
                me: meRes.data,
                availablePages: pages.map((page) => ({ id: page.id, name: page.name }))
            }
        }

        const ig = await this.fetchIgBusinessAccount(matchedPage.id, matchedPage.access_token)

        const result: TokenFromUserResponse200 = {
            user: meRes.data,
            page: { id: matchedPage.id, name: matchedPage.name },
            pageAccessToken: matchedPage.access_token
        }

        if (ig) {
            result.igBusinessAccount = { igId: ig.igId, username: ig.username }
        }

        if (!hasPagesMessaging) {
            result.warning =
                'Missing pages_messaging — subscription will fail. Regenerate token with this permission'
        }

        return result
    }

    public async exchangeCallbackCode(code: string | undefined, redirectUri?: string, errorDescription?: string) {
        if (!code) {
            return status(400, {
                error: 'Missing code parameter',
                error_description: errorDescription
            } as OauthCallbackErrorResponse400)
        }

        if (!env.FACEBOOK_APP_ID || !env.FACEBOOK_APP_SECRET) {
            return status(400, {
                error: 'FACEBOOK_APP_ID or FACEBOOK_APP_SECRET not configured'
            } as OauthCallbackErrorResponse400)
        }

        const tokenUrl = new URL(FB_TOKEN_URL)
        tokenUrl.searchParams.set('client_id', env.FACEBOOK_APP_ID)
        tokenUrl.searchParams.set('client_secret', env.FACEBOOK_APP_SECRET)
        tokenUrl.searchParams.set('redirect_uri', this.getCallbackUrl(redirectUri))
        tokenUrl.searchParams.set('code', code)

        const tokenRes = await fetch(tokenUrl)
        const tokenData = (await tokenRes.json()) as {
            access_token?: string
            error?: { message?: string }
        }

        if (!tokenRes.ok || !tokenData.access_token) {
            return status(400, {
                error: 'Token exchange failed',
                details: tokenData.error
            } as OauthCallbackErrorResponse400)
        }

        return { success: true, message: 'OAuth completed' } as OauthCallbackResponse200
    }

    private async graphApiGet(path: string, token: string): Promise<GraphApiResponse> {
        const url = new URL(`${FB_GRAPH_URL}${path}`)
        url.searchParams.set('access_token', token)

        try {
            const response = await fetch(url)
            return { ok: response.ok, data: await response.json() }
        } catch (error) {
            return { ok: false, data: String(error) }
        }
    }
}
