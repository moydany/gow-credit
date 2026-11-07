/**
 * The QR for linking the number (Baileys 7 no longer draws it). Rendered in the terminal and as an
 * image, since some terminals distort the blocks and the phone can't read them. The code holds no
 * personal data: it is the linking challenge, which expires in seconds and renews itself.
 */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import QRCode from 'qrcode'

export async function renderQrForTerminal(qr: string): Promise<string> {
  return QRCode.toString(qr, { type: 'terminal', small: true, errorCorrectionLevel: 'L' })
}

export async function writeQrPng(qr: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await QRCode.toFile(path, qr, { type: 'png', width: 512, margin: 2, errorCorrectionLevel: 'L' })
}
