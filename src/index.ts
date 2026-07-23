import { env } from './config/constants'

import app from './app'
import { shutdownQueues } from './lib/queue'
import { log } from './services/logger'

app.onStart(() => {
    log.info(`-`.repeat(50))
    log.info(`🦊 [Elysia] is running at ${app.server?.url}`)
    log.info(`🦊 [OpenAPI] is running at ${app.server?.url}docs`)
    log.info(`-`.repeat(50))
})
    .onStop(async () => {
        log.info(`-`.repeat(50))
        log.info(`🦊 [Elysia] is stopped`)
        await shutdownQueues()
        log.info(`-`.repeat(50))
    })
    .listen(env.PORT)
