import Elysia from 'elysia'

import { opentelemetry } from '@elysia/opentelemetry'

import cors from '@elysiajs/cors'
import { openapi } from '@elysiajs/openapi'
import serverTiming from '@elysiajs/server-timing'
import staticPlugin from '@elysiajs/static'

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node'

import { logger } from '@bogeychan/elysia-logger'
import { toJsonSchema } from '@valibot/to-json-schema'

import { rateLimit } from 'elysia-rate-limit'

import { globalErrorHandler } from './plugins/error-handler'

import router from './router'

import { env } from './config/constants'

import { tokenCronController } from './modules/tokens'
import { loggerPlugin } from './services/logger'

const app = new Elysia({ name: 'app.root' })
    // * Global Error Handler
    .use(globalErrorHandler)
    .use(loggerPlugin)
    // * OpenAPI Documentation
    .use(
        openapi({
            documentation: {
                info: {
                    title: env.PUBLIC_APP_NAME,
                    version: env.PUBLIC_APP_VERSION,
                    description: `${env.PUBLIC_APP_NAME} API Documentation`
                }
            },
            // * Map Valibot to JSON Schema [https://valibot.dev/guides/json-schema]
            mapJsonSchema: { valibot: toJsonSchema },
            path: '/docs'
        })
    )
    // * Load static files
    .use(
        staticPlugin({
            assets: 'public',
            prefix: '/',
            detail: { hide: true }
        })
    )
    // * CORS [https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS]
    .use(
        cors({
            aot: true,
            origin: true, // Use true to reflect origin when credentials: true
            allowedHeaders: ['*'],
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            credentials: true,
            maxAge: 86400
        })
    )
    // * Server Timing [https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Server-Timing]
    .use(serverTiming())
    // * OpenTelemetry [https://opentelemetry.io/]
    .use(
        opentelemetry({
            spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())]
        })
    )
    // * Rate Limit [https://elysia.dev/plugins/rate-limit]
    .use(
        rateLimit({
            max: env.RATE_LIMIT_MAX_REQUESTS,
            headers: true,
            duration: env.RATE_LIMIT_WINDOW,
            countFailedRequest: true,
            errorResponse: new Response('rate-limited', {
                status: 429,
                headers: new Headers({
                    'Content-Type': 'text/plain'
                }),
                statusText: 'rate-limited'
            }),
            scoping: 'global'
        })
    )
    // * Mount Router
    .use(router)
    // * Token Cron
    .use(tokenCronController)

export type App = typeof app
export default app
