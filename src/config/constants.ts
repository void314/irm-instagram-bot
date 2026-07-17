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
            DATABASE_URL: v.optional(v.string()),
            RATE_LIMIT_MAX_REQUESTS: v.optional(v.number(), 100),
            RATE_LIMIT_WINDOW: v.optional(v.number(), 60 * 1000),
            FACEBOOK_APP_ID: v.optional(v.string()),
            FACEBOOK_APP_SECRET: v.optional(v.string()),
            FACEBOOK_PAGE_ID: v.optional(v.string()),
            FACEBOOK_PAGE_ACCESS_TOKEN: v.optional(v.string()),
            INSTAGRAM_BUSINESS_ID: v.optional(v.string()),
            FACEBOOK_GRAPH_API_VERSION: v.optional(v.string(), 'v25.0'),
            WEBHOOK_VERIFY_TOKEN: v.optional(v.string()),
            WEBHOOK_AUTO_REPLY_TEXT: v.optional(v.string(), 'Thanks for your message! We will reply soon.'),
            TOKEN_ENCRYPTION_KEY: v.optional(v.string()),
            OPENROUTER_BASE_URL: v.optional(v.string(), 'https://openrouter.ai/api/v1'),
            OPENROUTER_API_KEY: v.optional(v.string()),
            LLM_MODEL: v.optional(v.string(), 'openai/gpt-4o-mini'),
            EMBED_MODEL: v.optional(v.string(), 'google/gemini-embedding-2'),
            RAG_TOP_K: v.optional(v.number(), 5)
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
