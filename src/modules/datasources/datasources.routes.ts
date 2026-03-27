import { FastifyInstance } from 'fastify'
import { requireApiKey } from '../../shared/middleware/api-key'

export default async function dataSourceRoutes(fastify: FastifyInstance) {
  const db   = fastify.prisma as any
  const auth = [requireApiKey]

  // ── GET /datasources
  fastify.get('/', { preHandler: auth }, async (req: any) => {
    return db.dataSource.findMany({
      where:   { projectId: req.project.id },
      select:  { id: true, name: true, type: true, isActive: true, lastSyncAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    })
  })

  // ── POST /datasources ── Register a new data source
  fastify.post('/', { preHandler: auth }, async (req: any, reply) => {
    const { name, type, config } = req.body as { name: string; type: string; config: any }
    if (!name?.trim()) return reply.code(400).send({ message: 'name is required' })
    if (!type?.trim()) return reply.code(400).send({ message: 'type is required (postgres | csv | excel | api)' })

    const ALLOWED_TYPES = ['postgres', 'csv', 'excel', 'api']
    if (!ALLOWED_TYPES.includes(type)) {
      return reply.code(400).send({ message: `type must be one of: ${ALLOWED_TYPES.join(', ')}` })
    }

    const ds = await db.dataSource.create({
      data: { projectId: req.project.id, name: name.trim(), type, config: config || {} },
    })
    return reply.code(201).send(ds)
  })

  // ── PATCH /datasources/:id ── Update name, config, or toggle active
  fastify.patch('/:id', { preHandler: auth }, async (req: any, reply) => {
    const existing = await db.dataSource.findFirst({ where: { id: req.params.id, projectId: req.project.id } })
    if (!existing) return reply.code(404).send({ message: 'Data source not found' })

    const { name, config, isActive } = req.body as any
    const data: any = {}
    if (name     !== undefined) data.name     = name.trim()
    if (config   !== undefined) data.config   = config
    if (isActive !== undefined) data.isActive = isActive

    return db.dataSource.update({ where: { id: req.params.id }, data })
  })

  // ── POST /datasources/:id/test ── Test a postgres connection
  fastify.post('/:id/test', { preHandler: auth }, async (req: any, reply) => {
    const ds = await db.dataSource.findFirst({ where: { id: req.params.id, projectId: req.project.id } })
    if (!ds) return reply.code(404).send({ message: 'Data source not found' })

    if (ds.type === 'postgres') {
      try {
        const { Client } = require('pg')
        const client = new Client({ connectionString: ds.config.connectionString })
        await client.connect()
        const result = await client.query('SELECT current_database(), current_user, version()')
        await client.end()
        await db.dataSource.update({ where: { id: ds.id }, data: { lastSyncAt: new Date() } })
        return { ok: true, info: result.rows[0] }
      } catch (e: any) {
        return reply.code(400).send({ ok: false, error: e.message })
      }
    }

    return { ok: true, message: 'Connection test not supported for this type yet' }
  })

  // ── DELETE /datasources/:id
  fastify.delete('/:id', { preHandler: auth }, async (req: any, reply) => {
    await db.dataSource.deleteMany({ where: { id: req.params.id, projectId: req.project.id } })
    return reply.code(204).send()
  })
}
