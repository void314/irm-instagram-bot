import { env } from './config/constants'
import { shutdownQueues } from './lib/queue'

import app from './app'

app.onStart(() => {
    console.log(`-`.repeat(50))
    console.log(`🦊 [Elysia] is running at ${app.server?.url}`)
    console.log(`🦊 [OpenAPI] is running at ${app.server?.url}docs`)
    console.log(`-`.repeat(50))
})
    .onStop(async () => {
        console.log(`-`.repeat(50))
        console.log(`🦊 [Elysia] is stopped`)
        await shutdownQueues()
        console.log(`-`.repeat(50))
    })
    .listen(env.PORT)
