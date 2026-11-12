import type { DshContext } from './dsh.ts'
import { dispatchUpdate, PluginUpdater } from './update-install.ts'
import { PLUGIN_VERSION } from './version.ts'

async function nativeUpdater(ctx: DshContext) {
  const appBoot = '@deepseek-ai/dsh-app-boot'
  const atomicWrite = '@deepseek-ai/dsh-atomic-write'
  const [boot, atomic] = await Promise.all([import(appBoot), import(atomicWrite)])
  const manager = ctx.pluginManager
  const credentials = ctx.credentials
  if (!manager || !ctx.profileContext || !credentials.describe || !credentials.unset) throw new Error('Missing updater service')
  return new PluginUpdater({
    profile: ctx.profileContext.dir, running: PLUGIN_VERSION, manager,
    credentials: {
      describe: credentials.describe.bind(credentials), resolve: credentials.resolve.bind(credentials),
      set: credentials.set.bind(credentials), unset: credentials.unset.bind(credentials),
    }, atomic: { withFileLock: atomic.withFileLock, writeFileAtomic: atomic.writeFileAtomic },
    compatible: manifest => {
      try {
        boot.assertBundlePlatform(manifest.dsh.bundle.platforms, process.platform)
        return boot.evaluatePluginCompatibility(manifest, {}, boot.getDshRuntimeVersion()) === undefined
      } catch { return false }
    },
  })
}
export async function installUpdateService(ctx: DshContext) {
  const cordis = '@deepseek-ai/cordis'
  const protocol = '@deepseek-ai/dsh-typert-protocol'
  const [{ Service }, { Remote, bindTypertRemote, principalOf }] = await Promise.all([import(cordis), import(protocol)])
  let instance: Promise<PluginUpdater> | undefined
  const get = () => instance ??= nativeUpdater(ctx).catch(error => { instance = undefined; throw error })
  class CrowdtestUpdate extends Service {
    readonly typertRemote
    constructor() { super(ctx, 'crowdtestUpdate'); this.typertRemote = bindTypertRemote(this, 'crowdtestUpdate') }
    @Remote inspect(input: unknown) { return dispatchUpdate(principalOf(this.ctx.invocation), 'inspect', input, get) }
    @Remote check(input: unknown) { return dispatchUpdate(principalOf(this.ctx.invocation), 'check', input, get) }
    @Remote start(input: unknown) { return dispatchUpdate(principalOf(this.ctx.invocation), 'start', input, get) }
    @Remote saveCredential(input: unknown) { return dispatchUpdate(principalOf(this.ctx.invocation), 'saveCredential', input, get) }
    @Remote removeCredential(input: unknown) { return dispatchUpdate(principalOf(this.ctx.invocation), 'removeCredential', input, get) }
  }
  new CrowdtestUpdate()
}
