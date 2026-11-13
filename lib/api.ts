import { NextResponse } from "next/server"

/**
 * Satu pintu untuk semua tangkapan error di API routes.
 * Pesan yang diawali "[Duitin]" adalah pesan perbaikan yang sengaja
 * dibuat untuk pengguna (mis. env var Turso belum dipasang) —
 * tampilkan apa adanya. Selain itu tampilkan pesan ramah default.
 */
export function fail(error: unknown, fallback: string) {
  const msg = error instanceof Error ? error.message : ""
  const detail = msg.startsWith("[Duitin]") ? msg : fallback
  return NextResponse.json({ error: detail }, { status: 500 })
}
