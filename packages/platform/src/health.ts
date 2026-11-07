import { createServer } from 'node:http'

/**
 * Cloud Run requires a service to listen on PORT even with no traffic: with the variable set, a
 * minimal health listener on all interfaces; without it (local), nothing.
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
