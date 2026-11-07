import { createServer } from 'node:http'

/**
 * Cloud Run exige que un servicio escuche en PORT aunque no reciba tráfico: con la variable, un
 * listener mínimo de salud en todas las interfaces; sin ella (local), nada.
 */
export function startHealthListener(log: (message: string) => void): void {
  const port = process.env.PORT
  if (!port) return
  createServer((_req, res) => {
    res.statusCode = 200
    res.end('ok')
  }).listen(Number(port), '0.0.0.0', () => {
    log(`listener de salud en el puerto ${port}`)
  })
}
