import { defineScheduled } from 'void'
import { cleanupExpiredArtifacts } from '../src/preview/cleanupExpired'

// Daily maintenance. Refs self-expire from the indexes (skipped on read, pruned
// on the next write), but their per-version R2 objects (meta + tarball) would
// otherwise orphan forever. This deletes the ones past the ref TTL so storage
// stays bounded to the active-ref window, "in advance" of any manual purge.
export const cron = '37 3 * * *' // 03:37 UTC daily (off the hour)

export default defineScheduled(async (_controller, env) => {
  const { deleted } = await cleanupExpiredArtifacts(env)
  console.log(`cleanup-expired: deleted ${deleted} expired preview artifact(s)`)
})
