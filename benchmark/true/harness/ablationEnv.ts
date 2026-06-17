const KEY = '_ABLATION_VSM_DISABLED'

/**
 * Run `body` with the VSM ablation flag set for the given arm, restoring the
 * environment afterward. governed=true -> flag deleted; governed=false -> flag='1'.
 */
export async function withAblationEnv<T>(governed: boolean, body: () => Promise<T>): Promise<T> {
  if (governed) delete process.env[KEY]
  else process.env[KEY] = '1'
  try {
    return await body()
  } finally {
    delete process.env[KEY]
  }
}
