import Elysia, { status } from 'elysia'

import * as models from './model'
import { env } from '../../../config/constants'
import { TokenService } from '../../tokens/service'
import { FacebookAuthService } from './service'

export const authController = new Elysia({
    name: 'module.auth.facebook',
    prefix: '/auth/facebook',
    detail: { tags: ['Auth'] }
})
    .decorate('facebookAuthService', new FacebookAuthService())
    .decorate('tokenService', new TokenService())
    .model(models)
    .get(
        '/login',
        ({ query, set, facebookAuthService }) => {
            if (!env.FACEBOOK_APP_ID) {
                return status(400, { error: 'FACEBOOK_APP_ID not configured' })
            }

            set.redirect = facebookAuthService.getLoginRedirectUrl(query.redirect_uri)
            return
        },
        {
            query: 'facebookLoginQuery',
            detail: {
                summary: 'Facebook OAuth login',
                description: 'Redirect to Facebook OAuth dialog to obtain user permissions'
            }
        }
    )
    .post(
        '/token-from-user',
        async ({ body, facebookAuthService, tokenService }) => {
            const result = await facebookAuthService.exchangeUserToken(body.userToken)

            if ('error' in result) {
                return status(400, result)
            }

            if (result.igBusinessAccount) {
                await tokenService.saveToken(
                    result.igBusinessAccount.igId,
                    result.igBusinessAccount.username ?? null,
                    result.pageAccessToken,
                    null
                )
            }

            return result
        },
        {
            body: 'userTokenBody',
            response: {
                200: 'tokenFromUserResponse200',
                400: 'tokenFromUserErrorResponse400'
            },
            detail: {
                summary: 'Exchange user token for page access token',
                description:
                    'Takes a Facebook User Access Token and returns the Page Access Token for the configured page. ' +
                    'Useful for debugging and initial setup.'
            }
        }
    )
    .get(
        '/callback',
        async ({ query, facebookAuthService }) => {
            return await facebookAuthService.exchangeCallbackCode(
                query.code,
                query.redirect_uri,
                query.error_description
            )
        },
        {
            query: 'facebookCallbackQuery',
            response: {
                200: 'oauthCallbackResponse200',
                400: 'oauthCallbackErrorResponse400'
            },
            detail: {
                summary: 'Facebook OAuth callback',
                description: 'Handles the OAuth redirect from Facebook, exchanges the code for an access token'
            }
        }
    )
