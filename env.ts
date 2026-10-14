import { defineEnv, string } from 'void/env'

// Void stores schema-declared server values as remote secrets in production.
// Public settings use worker.vars in void.config.ts instead.
export default defineEnv({
  // Bearer token guarding the admin endpoints. Secret: `void secret put ADMIN_TOKEN`.
  ADMIN_TOKEN: string().optional(),
})
