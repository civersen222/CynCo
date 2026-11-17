import type { Provider } from '../provider.js'
import { OllamaProvider } from '../ollama/client.js'
import { LlamaCppProvider } from '../llama/provider.js'
import { PROVIDER_TYPES, providerFromName, type ProviderType } from './names.js'

export { PROVIDER_TYPES, providerFromName, type ProviderType }

export function createProvider(type: ProviderType, baseUrl: string, _apiKey?: string, contextLength?: number): Provider {
  switch (type) {
    case 'ollama':
      return new OllamaProvider({ baseUrl, contextLength })
    case 'llama-cpp':
      return new LlamaCppProvider({
        primaryUrl: baseUrl || 'http://127.0.0.1:8081',
        modelName: 'unknown',
        modelsDir: '',
      })
    default:
      // Unreachable through the type. A name forced past it is not turned into an Ollama client any more.
      throw new Error(`createProvider: "${String(type)}" is not a provider CynCo has (${PROVIDER_TYPES.join(', ')})`)
  }
}
