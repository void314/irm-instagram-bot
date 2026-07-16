import * as v from 'valibot'
import { createEnv } from 'valibot-env'

import pkg from '../../package.json'

const env = createEnv({
    publicPrefix: 'PUBLIC_',
    schema: {
        public: {
            PUBLIC_APP_NAME: v.optional(v.string(), pkg.name),
            PUBLIC_APP_VERSION: v.optional(v.string(), pkg.version)
        },
        private: {
            PORT: v.optional(v.number(), 3032),
            RATE_LIMIT_MAX_REQUESTS: v.optional(v.number(), 100),
            RATE_LIMIT_WINDOW: v.optional(v.number(), 60 * 1000)
        },
        shared: {
            NODE_ENV: v.optional(
                v.union([v.literal('development'), v.literal('production'), v.literal('test')]),
                'development'
            ),
            VERCEL_ENV: v.optional(
                v.union([v.literal('development'), v.literal('preview'), v.literal('production')]),
                'development'
            )
        }
    },
    values: process.env || Bun.env
})

export { env }
