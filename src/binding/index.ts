/**
 * Barrel for the OpenClaw ↔ AgentChat binding layer.
 *
 * Everything inside `src/binding/` is the bridge between the doorbell and
 * OpenClaw's plugin contract. `channel.ts` wires the adapters into the
 * exported `agentchatPlugin`.
 */

export { agentchatGatewayAdapter, waitUntilAbort } from './gateway.js'
export { agentchatStatusAdapter } from './status.js'
export { agentchatDoctorAdapter } from './doctor.js'

export { getClient, disposeClient, resetClientCacheForTest } from './sdk-client.js'

export {
  registerDoorbell,
  unregisterDoorbell,
  getDoorbell,
  listActiveAccounts,
  resetRegistryForTest,
} from './runtime-registry.js'

export type { AgentchatProbeResult } from './status.js'
