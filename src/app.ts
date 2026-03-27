import Fastify from 'fastify'
import cors from '@fastify/cors'
import path from 'path'
import { registerPrisma } from './shared/plugins/prisma'
import { AppError } from './shared/errors'
import { config } from './config'

import projectRoutes    from './modules/projects/projects.routes'
import agentRoutes      from './modules/agents/agents.routes'
import boardRoutes      from './modules/board/board.routes'
import chatRoutes       from './modules/chat/chat.routes'
import strategyRoutes   from './modules/strategy/strategy.routes'
import datasourceRoutes from './modules/datasources/datasources.routes'

export async function buildApp() {
  const fastify = Fastify({
    logger: config.isDev
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : true,
  })

  // ── Plugins ────────────────────────────────────────────────────────────────
  await fastify.register(cors, { origin: true })
  await registerPrisma(fastify)

  // ── Serve static UI ────────────────────────────────────────────────────────
  await fastify.register(require('@fastify/static'), {
    root:   path.join(__dirname, '..', 'web'),
    prefix: '/',
    decorateReply: false,
  })

  // ── API routes ─────────────────────────────────────────────────────────────
  await fastify.register(projectRoutes,    { prefix: '/projects' })
  await fastify.register(agentRoutes,      { prefix: '/agents' })
  await fastify.register(boardRoutes,      { prefix: '/board' })
  await fastify.register(chatRoutes,       { prefix: '/chat' })
  await fastify.register(strategyRoutes,   { prefix: '/strategy' })
  await fastify.register(datasourceRoutes, { prefix: '/datasources' })

  // ── Global error handler ───────────────────────────────────────────────────
  fastify.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ message: err.message, code: err.code })
    }
    fastify.log.error(err)
    return reply.code(500).send({ message: 'Internal server error', code: 'INTERNAL_ERROR' })
  })

  return fastify
}
