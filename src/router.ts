import Elysia from 'elysia'

import { authController } from './modules/auth/facebook'
import { healthController } from './modules/health'
import { instagramController } from './modules/instagram'
import { ragController } from './modules/rag'
import { instagramWebhookController } from './modules/webhook/instagram'

const router = new Elysia({
    name: 'router.api',
    prefix: '/api'
})
    .use(authController)
    .use(healthController)
    .use(instagramController)
    .use(ragController)
    .use(instagramWebhookController)

export default router
