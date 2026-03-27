import { buildApp } from './app'
import { config }   from './config'

async function start() {
  const app = await buildApp()
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' })
    console.log(`Bohlale running on port ${config.port}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
