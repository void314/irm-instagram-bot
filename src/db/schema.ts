import { bigint, jsonb, pgTable, text, timestamp, vector } from 'drizzle-orm/pg-core'

export const conversations = pgTable('conversations', {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    senderId: text('sender_id').notNull(),
    businessId: text('business_id').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>()
})

export const messages = pgTable('messages', {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    conversationId: bigint('conversation_id', { mode: 'bigint' })
        .notNull()
        .references(() => conversations.id, { onDelete: 'cascade' }),
    mid: text('mid'),
    fromId: text('from_id').notNull(),
    text: text('text'),
    embedding: vector('embedding', { dimensions: 1536 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>()
})

export const accounts = pgTable('accounts', {
    igId: text('ig_id').primaryKey(),
    username: text('username'),
    accessToken: text('access_token'),
    tokenExpiresAt: timestamp('token_expires_at'),
    lastInteraction: timestamp('last_interaction').defaultNow().notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>()
})
