import Elysia from 'elysia'

import * as models from './model'
import { InstagramService } from './service'

export const instagramController = new Elysia({
    name: 'module.instagram',
    prefix: '/instagram',
    detail: { tags: ['Instagram'] }
})
    .decorate('instagramService', new InstagramService())
    .model(models)
    .get(
        '/me',
        async ({ instagramService }) => {
            return await instagramService.getProfile()
        },
        {
            response: {
                200: 'instagramProfileResponse200',
                400: 'instagramProfileResponse400'
            },
            detail: {
                summary: 'Instagram profile check',
                description: 'Verify access to Instagram Business Account via Graph API'
            }
        }
    )
