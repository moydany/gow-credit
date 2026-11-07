/**
 * Movement-table spec for each dev bank. Format only (coordinates, date expressions, start and end
 * markers); no holder data.
 */
import type { Line } from './layout.ts'
import type { TableSpec } from './parse-table.ts'
import { iso, monthNumber } from './table.ts'

const first = (l: Line) => l.segments[0]?.str ?? ''
const firstX = (l: Line) => l.segments[0]?.x ?? 999

export interface BankSpec {
  bank: string
  file: string
  tables: TableSpec[]
  /** Table order: Nu prints newest to oldest. */
  reverseChronological?: boolean
}

// ---------- Inbursa: DATE "ENE. 16" + reference in the same segment; CARGOS, ABONOS, SALDO.
const inbursa: BankSpec = {
  bank: 'inbursa',
  file: 'EDC_01_Inbursa_2025-01.pdf',
  tables: [
    {
      pages: () => true,
      start: /FECHA .*REFERENCIA .*CONCEPTO/,
      stop: /Las instituciones que componen|BANCO INBURSA, S\.A\.|RESUMEN DEL CFDI|Si desea recibir/,
      isAnchor: (l) => firstX(l) < 30 && /^[A-Z]{3}\. \d{2}\b/.test(first(l)),
      parseAnchor: (l) => {
        const m = /^([A-Z]{3})\. (\d{2})(?: (.+))?$/.exec(first(l))
        if (!m) throw new Error('ancla inbursa')
        return { date: iso(2025, monthNumber(m[1] ?? ''), Number(m[2])), reference: m[3]?.trim() ?? null, head: null }
      },
      columns: { debit: 441, credit: 508, balance: 562 },
      description: [130, 400],
      attach: 'following',
      skip: (r) => /BALANCE INICIAL/.test(r.description),
    },
  ],
}

// ---------- Hey: DIA (day only) + description; CARGOS, ABONOS, SALDO. April 2025.
const hey: BankSpec = {
  bank: 'hey',
  file: 'EDC_02_Hey_2025-04.pdf',
  tables: [
    {
      pages: () => true,
      start: /^DIA CONCEPTO CARGOS ABONOS/,
      stop: /^Total\b|Gráfico Transaccional|Tasa Bruta/,
      isAnchor: (l) => firstX(l) < 45 && /^\d{2}$/.test(first(l)),
      parseAnchor: (l) => ({ date: iso(2025, 4, Number(first(l))), reference: null, head: null }),
      columns: { debit: 417, credit: 497, balance: 572 },
      description: [50, 390],
      attach: 'following',
    },
  ],
}

// ---------- Fondeadora: dd/mm/yyyy; Cargos and Abonos (the other is 0.00), Saldo.
const fondeadora: BankSpec = {
  bank: 'fondeadora',
  file: 'EDC_03_Fondeadora_2025-10.pdf',
  tables: [
    {
      pages: () => true,
      start: /^Fecha Descripción Cargos Abonos Saldo/,
      stop: /Fondea Technologies|^Pag \d/,
      isAnchor: (l) => /^\d{2}\/\d{2}\/\d{4}$/.test(first(l)),
      parseAnchor: (l) => {
        const [d, m, y] = first(l).split('/').map(Number)
        return { date: iso(y ?? 0, m ?? 0, d ?? 0), reference: null, head: null }
      },
      columns: { debit: 423, credit: 489, balance: 553 },
      description: [140, 380],
      attach: 'following',
    },
  ],
}

// ---------- BBVA: OPER and LIQ "01/SEP"; COD. DESCRIPCIÓN; CARGOS, ABONOS; operation and settlement
// balance only on the last row of each day.
const bbva: BankSpec = {
  bank: 'bbva',
  file: 'EDC_05_BBVA_2025-09.pdf',
  tables: [
    {
      pages: () => true,
      start: /^OPER LIQ/,
      stop: /^Total de Movimientos|^La GAT Real|^BBVA MEXICO, S\.A\.|Estimado Cliente|^Le informamos/,
      isAnchor: (l) => firstX(l) < 20 && /^\d{2}\/[A-Z]{3}$/.test(first(l)),
      parseAnchor: (l) => {
        const [d, m] = first(l).split('/')
        return { date: iso(2025, monthNumber(m ?? ''), Number(d)), reference: null, head: null }
      },
      columns: { debit: 398, credit: 459, balance: 526, balance2: 594 },
      description: [45, 350],
      attach: 'following',
    },
  ],
}

// ---------- Mercado Pago: dd-mm-yyyy; description vertically centered (lines above and below the
// date); operation ID; signed Valor; Saldo.
const mercadoPago: BankSpec = {
  bank: 'mercadopago',
  file: 'EDC_06_MercadoPago_2026-06a09.pdf',
  tables: [
    {
      pages: () => true,
      start: /^Fecha Descripción/,
      startOptional: true,
      stop: /^\d{1,2}\/\d{1,2}$|^Fecha de generación/,
      isAnchor: (l) => /^\d{2}-\d{2}-\d{4}$/.test(first(l)),
      parseAnchor: (l) => {
        const [d, m, y] = first(l).split('-').map(Number)
        return { date: iso(y ?? 0, m ?? 0, d ?? 0), reference: null, head: null }
      },
      columns: { amount: 338, balance: 403 },
      description: [90, 210],
      reference: [210, 290],
      attach: 'nearest',
      band: 14,
      orphan: 'next',
      isNoise: (l) => /^(ID de la|operación)$/.test(first(l)),
    },
  ],
}

// ---------- Santander: "01-ABR-2025 FOLIO CONCEPTO" in one segment; DEPOSITO, RETIRO, SALDO.
// Checking account with movements; the investment has an empty table (TOTAL 0.00).
const santander: BankSpec = {
  bank: 'santander',
  file: 'EDC_07_Santander_2025-04.pdf',
  tables: [
    {
      pages: () => true,
      start: /^FECHA FOLIO DESCRIPCION/,
      stop: /^TOTAL\b|^Página \d+ de \d+/,
      isAnchor: (l) => firstX(l) < 40 && /^\d{2}-[A-Z]{3}-\d{4}\b/.test(first(l)),
      parseAnchor: (l) => {
        const m = /^(\d{2})-([A-Z]{3})-(\d{4})(?: (\S+))?(?: (.*))?$/.exec(first(l))
        if (!m) throw new Error('ancla santander')
        return { date: iso(Number(m[3]), monthNumber(m[2] ?? ''), Number(m[1])), reference: m[4] ?? null, head: m[5]?.trim() ?? null }
      },
      columns: { credit: 429, debit: 497, balance: 581 },
      description: [100, 380],
      attach: 'following',
    },
  ],
}

// ---------- Nu: "30 JUL 2025"; description centered with detail below; signed MONTO; no balance
// per row; newest to oldest. Only the account detail (the cajitas sections repeat the transfers).
const nu: BankSpec = {
  bank: 'nu',
  file: 'EDC_08_Nu_2025-07.pdf',
  reverseChronological: true,
  tables: [
    {
      pages: (p) => p >= 2 && p <= 22,
      start: /^FECHA DEL \d{2} AL/,
      stop: /^Nu México Financiera|^Detalle de movimientos de tus cajitas/,
      isAnchor: (l) => firstX(l) < 70 && /^\d{2} [A-Z]{3} \d{4}$/.test(first(l)),
      parseAnchor: (l) => {
        const [d, m, y] = first(l).split(' ')
        return { date: iso(Number(y), monthNumber(m ?? ''), Number(d)), reference: null, head: null }
      },
      columns: { amount: 539 },
      description: [120, 480],
      attach: 'nearest',
      band: 11,
      orphan: 'previous',
      internalTransfer: (r) => /^(Depósito en Cajita|Retiro de Cajita|Agregado a tu dinero de respaldo|Retirado de tu dinero de respaldo)\b/i.test(r.description_head),
    },
  ],
}

// ---------- Banamex: "03 FEB"; the description spans several lines and the amount is on the last
// line of the row; RETIROS, DEPOSITOS, SALDO. The business investment has no movements.
const banamex: BankSpec = {
  bank: 'banamex',
  file: 'EDC_04_Banamex_2026-02.pdf',
  tables: [
    {
      pages: () => true,
      start: /^FECHA CONCEPTO RETIROS DEPOSITOS SALDO/,
      stop: /^\d{6}\.B\d{2}[A-Z]+|^SALDO MINIMO REQUERIDO/,
      isAnchor: (l) => firstX(l) < 30 && /^\d{2} [A-Z]{3}$/.test(first(l)),
      parseAnchor: (l) => {
        const [d, m] = first(l).split(' ')
        return { date: iso(2026, monthNumber(m ?? ''), Number(d)), reference: null, head: null }
      },
      columns: { debit: 320, credit: 395, balance: 475 },
      description: [48, 260],
      attach: 'following',
      // SALDO ANTERIOR and the informational exempt-withdrawals counter are not movements.
      skip: (r) => /^SALDO ANTERIOR\b/.test(r.description) || (r.amount === 0 && /DISPOSICIONES EN CAJERO EXENTAS/.test(r.description)),
    },
  ],
}

// ---------- HSBC: EBCDIC text layer (decoded); day; description; Referencia/Serial on two lines;
// Retiro/Cargo, Depósito/Abono and Saldo with "$". March 2026.
const hsbc: BankSpec = {
  bank: 'hsbc',
  file: 'EDC_09_HSBC_2026-03.pdf',
  tables: [
    {
      pages: () => true,
      start: /^Día Descripción/,
      stop: /^SALDO FINAL|^Saldo Final|^TOTAL|^Total|^SALDO PROMEDIO|^CoDi:|^Emitido por:/,
      isAnchor: (l) => firstX(l) < 50 && /^\d{2}$/.test(first(l)),
      parseAnchor: (l) => ({ date: iso(2026, 3, Number(first(l))), reference: null, head: null }),
      columns: { debit: 403, credit: 473, balance: 566 },
      description: [58, 295],
      reference: [295, 345],
      attach: 'following',
      isNoise: (l) => /^(Referencia\/|Serial)$/.test(first(l)),
    },
  ],
}

export const BANKS: BankSpec[] = [inbursa, hey, fondeadora, bbva, mercadoPago, santander, nu, banamex, hsbc]
