import { bigint, index, integer, jsonb, pgTable, text, timestamp, vector } from 'drizzle-orm/pg-core'

export const conversations = pgTable('conversations', {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    senderId: text('sender_id').notNull(),
    businessId: text('business_id').notNull(),
    summary: text('summary'),
    messageCount: integer('message_count').default(0).notNull(),
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
    embedding: vector('embedding', { dimensions: 3072 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>()
})

export const documents = pgTable('documents', {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    title: text('title').notNull(),
    source: text('source').notNull().default('manual'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').defaultNow().notNull()
})

export const chunks = pgTable('chunks', {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    documentId: bigint('document_id', { mode: 'bigint' })
        .notNull()
        .references(() => documents.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: 3072 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').defaultNow().notNull()
})

export const accounts = pgTable('accounts', {
    igId: text('ig_id').primaryKey(),
    username: text('username'),
    tokenEncrypted: text('token_encrypted'),
    tokenIv: text('token_iv'),
    tokenExpiresAt: timestamp('token_expires_at'),
    lastRefreshAt: timestamp('last_refresh_at'),
    refreshError: text('refresh_error'),
    lastInteraction: timestamp('last_interaction').defaultNow().notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>()
})
