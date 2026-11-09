import express from 'express'
import { applicationsRouter } from './bo/applications.ts'
import { authMeRouter, authMiddleware, authPublicRouter, type SessionLimits } from './bo/auth.ts'
import { jobsRouter } from './bo/jobs.ts'
import { llmRouter } from './bo/llm.ts'
import { policiesRouter } from './bo/policies.ts'
import { promptsRouter } from './bo/prompts.ts'
import { settingsRouter } from './bo/settings.ts'
import { type BackofficeDeps } from './bo/shared.ts'
import { statementsRouter } from './bo/statements.ts'
import { suppliersRouter } from './bo/suppliers.ts'
import { teamRouter } from './bo/team.ts'
import { timelineRouter } from './bo/timeline.ts'

export type { BackofficeDeps }

export function backofficeRouter(deps: BackofficeDeps): express.Router {
  const r = express.Router()
  r.use(express.json({ limit: '2mb' }))
  r.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store')
    next()
  })

  const limits: SessionLimits = {
    maxSeconds: (deps.sessionMaxHours ?? 12) * 3600,
    idleSeconds: (deps.sessionIdleHours ?? 8) * 3600,
  }

  r.use(authPublicRouter(deps, limits))
  r.use(authMiddleware(deps, limits))
  r.use(authMeRouter(deps))
  r.use(applicationsRouter(deps))
  r.use(policiesRouter(deps))
  r.use(suppliersRouter(deps))
  r.use(statementsRouter(deps))
  r.use(settingsRouter(deps))
  r.use(teamRouter(deps))
  r.use(llmRouter(deps))
  r.use(jobsRouter(deps))
  r.use(timelineRouter(deps))
  r.use(promptsRouter(deps))

  return r
}
