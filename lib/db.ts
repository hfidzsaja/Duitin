import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { createClient, type Client } from '@libsql/client'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import path from 'path'
import { SCHEMA_SQL } from '@/lib/ddl'

// ============================================================
// Lapisan tahan-banting v3 — ATURAN UTAMA:
// 1. Modul TIDAK PERNAH crash saat dimuat (semua koneksi dibuat
//    malas/lazy). Kalau DB bermasalah, API mengembalikan pesan
//    JSON Bahasa Indonesia yang menjelaskan cara memperbaikinya.
// 2. DATABASE_URL kosong/"undefined" di KOMPUTER LOKAL → otomatis
//    SQLite file (db/custom.db).
// 3. Di VERCEL / NETLIFY filesystem hanya-baca → file SQLite
//    TIDAK MUNGKIN jalan. Kalau DATABASE_URL bukan libsql://
//    (Turso), API langsung memberi tahu pengguna apa yang harus
//    dipasang — bukan crash 500 misterius.
// 4. Tabel dibuat otomatis sekali per proses (IF NOT EXISTS).
// ============================================================

const LOCAL_URL = 'file:./db/custom.db'

const TAG = '[Duitin]'
function setupError(msg: string): Error {
  return new Error(`${TAG} ${msg}`)
}

const PANDUAN_TURSO =
  'Cara memperbaiki: (1) Install Turso: curl -sSfL https://get.turso.tech | bash — (2) Buat database: turso db create duitin — (3) Ambil alamat: turso db show duitin --url dan token: turso db tokens create duitin — (4) Di dashboard Vercel/Netlify buka Settings -> Environment Variables lalu tambahkan DATABASE_URL (isi libsql://...) dan DATABASE_AUTH_TOKEN (isi token) — (5) Klik Redeploy. Panduan lengkap ada di file panduan deploy.'

// Serverless = filesystem hanya-baca, file SQLite tidak bisa dipakai.
function isServerless(): boolean {
  return Boolean(
    process.env.VERCEL ||
      process.env.NETLIFY ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.RENDER ||
      process.env.FLY_MACHINE_ID
  )
}

function resolveDbUrl(): string {
  const raw = (process.env.DATABASE_URL ?? '').trim()
  if (!raw || raw === 'undefined' || raw === 'null') return LOCAL_URL
  return raw
}

function resolveSetupError(): Error | null {
  const url = resolveDbUrl()
  const token = (process.env.DATABASE_AUTH_TOKEN ?? '').trim()

  // Di serverless, file SQLite tidak bisa dipakai — wajib Turso.
  if (isServerless() && (url.startsWith('file:') || url === LOCAL_URL)) {
    return setupError(
      'DATABASE_URL belum diisi (atau masih menunjuk ke file lokal) di Vercel/Netlify. Di serverless, file SQLite tidak bisa dipakai — wajib pakai database cloud Turso. ' +
        PANDUAN_TURSO
    )
  }

  // Turso tanpa token → pasti ditolak server.
  if (url.startsWith('libsql://') && !token) {
    return setupError(
      'DATABASE_AUTH_TOKEN belum diisi. Turso membutuhkan token akses. Jalankan "turso db tokens create duitin", lalu tambahkan env var DATABASE_AUTH_TOKEN di dashboard Vercel/Netlify dan Redeploy. ' +
        PANDUAN_TURSO
    )
  }

  // File lokal: pastikan foldernya bisa ditulis (cek sekali).
  if (url.startsWith('file:')) {
    const rel = url.slice('file:'.length).split('?')[0]
    const abs = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel)
    try {
      mkdirSync(path.dirname(abs), { recursive: true })
      const probe = path.join(path.dirname(abs), `.duitin-write-test-${process.pid}`)
      writeFileSync(probe, 'ok')
      rmSync(probe)
    } catch {
      return setupError(
        'Folder database tidak bisa ditulis di server ini. Di Vercel/Netlify/Render filesystem hanya-baca, jadi wajib pakai Turso (libsql://). ' +
          PANDUAN_TURSO
      )
    }
  }
  return null
}

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient
  duitinSchemaClient?: Client
  duitinSchemaReady?: Promise<void>
  duitinSetupError?: Error | null
}

function getSetupError(): Error | null {
  if (globalForPrisma.duitinSetupError === undefined) {
    globalForPrisma.duitinSetupError = resolveSetupError()
  }
  return globalForPrisma.duitinSetupError
}

function buildConfig(): { url: string; authToken?: string } {
  const url = resolveDbUrl()
  const token = (process.env.DATABASE_AUTH_TOKEN ?? '').trim() || undefined
  return { url, authToken: token }
}

// Semua koneksi dibuat MALAS — modul ini aman dimuat di mana pun.
function getPrisma(): PrismaClient {
  if (globalForPrisma.prisma) return globalForPrisma.prisma
  const err = getSetupError()
  if (err) throw err
  // Prisma membaca env("DATABASE_URL") — pastikan selalu valid.
  process.env.DATABASE_URL = resolveDbUrl()
  const config = buildConfig()
  const client = new PrismaClient({ adapter: new PrismaLibSql(config) })
  globalForPrisma.prisma = client
  return client
}

function getSchemaClient(): Client {
  if (globalForPrisma.duitinSchemaClient) return globalForPrisma.duitinSchemaClient
  const err = getSetupError()
  if (err) throw err
  const client = createClient(buildConfig())
  globalForPrisma.duitinSchemaClient = client
  return client
}

function ensureSchema(): Promise<void> {
  const err = getSetupError()
  if (err) return Promise.reject(err)
  if (!globalForPrisma.duitinSchemaReady) {
    const run = (async () => {
      const client = getSchemaClient()
      const statements = SCHEMA_SQL.split(';')
        .map((s) => s.replace(/^\s*--[^\n]*/gm, '').trim())
        .filter(Boolean)
      for (const sql of statements) {
        await client.execute(sql)
      }
    })()
    globalForPrisma.duitinSchemaReady = run.catch((raw) => {
      // Gagal sekarang → dicoba ulang otomatis di request berikutnya
      globalForPrisma.duitinSchemaReady = undefined
      const msg = raw instanceof Error ? raw.message : String(raw)
      throw setupError(
        `Gagal menyiapkan tabel database: ${msg}. Cek kembali DATABASE_URL dan DATABASE_AUTH_TOKEN, lalu jalankan "turso db shell duitin < turso-schema.sql" untuk membuat tabel.`
      )
    })
  }
  return globalForPrisma.duitinSchemaReady
}

/**
 * Proxy dua lapis: setiap `db.<model>.<method>(...)` otomatis
 * menunggu ensureSchema selesai, lalu diteruskan ke Prisma.
 * Kode di seluruh aplikasi tidak perlu berubah.
 */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_t, model: string) {
    return new Proxy({}, {
      get(_t2, method: string) {
        return (...args: unknown[]) =>
          ensureSchema()
            .catch((e) => { throw e })
            .then(() =>
              (getPrisma() as unknown as Record<string, (...a: unknown[]) => unknown>)[
                model
              ][method](...args)
            )
      },
    })
  },
}) as PrismaClient
