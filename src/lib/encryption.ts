import { env } from '../config/constants'

const ALGORITHM = 'AES-GCM'
const KEY_LENGTH = 32
const IV_LENGTH = 12

function getRawKey(): Uint8Array {
    const raw = env.TOKEN_ENCRYPTION_KEY
    if (!raw) {
        throw new Error('TOKEN_ENCRYPTION_KEY is not set')
    }
    if (raw.length !== 64) {
        throw new Error('TOKEN_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)')
    }
    const key = new Uint8Array(KEY_LENGTH)
    for (let i = 0; i < KEY_LENGTH; i++) {
        key[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16)
    }
    return key
}

function toBase64(buf: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < buf.length; i++) {
        binary += String.fromCharCode(buf[i])
    }
    return btoa(binary)
}

function fromBase64(str: string): Uint8Array {
    const binary = atob(str)
    const buf = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        buf[i] = binary.charCodeAt(i)
    }
    return buf
}

export async function encryptToken(plaintext: string): Promise<{ ciphertext: string; iv: string }> {
    const rawKey = getRawKey()
    const cryptoKey = await crypto.subtle.importKey('raw', rawKey as unknown as ArrayBuffer, ALGORITHM, false, [
        'encrypt'
    ])

    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
    const encoded = new TextEncoder().encode(plaintext)

    const encrypted = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, cryptoKey, encoded)

    return {
        ciphertext: toBase64(new Uint8Array(encrypted)),
        iv: toBase64(iv)
    }
}

export async function decryptToken(ciphertext: string, iv: string): Promise<string> {
    const rawKey = getRawKey()
    const cryptoKey = await crypto.subtle.importKey('raw', rawKey as unknown as ArrayBuffer, ALGORITHM, false, [
        'decrypt'
    ])

    const decrypted = await crypto.subtle.decrypt(
        { name: ALGORITHM, iv: fromBase64(iv) as unknown as ArrayBuffer },
        cryptoKey,
        fromBase64(ciphertext) as unknown as ArrayBuffer
    )

    return new TextDecoder().decode(decrypted)
}

