/**
 * El QR para vincular el número (Baileys 7 ya no lo dibuja). Va en la terminal y también como
 * imagen, porque algunas terminales deforman los bloques y el teléfono no lo lee. El código no tiene
 * datos personales: es el reto de vinculación, que caduca en segundos y se renueva solo.
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
