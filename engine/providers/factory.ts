import type { Provider } from '../provider.js'
import { OllamaProvider } from '../ollama/client.js'
import { OpenAICompatProvider } from './openaiCompat.js'

export type ProviderType = 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'openai-compat'

export function createProvider(type: ProviderType, baseUrl: string, apiKey?: string, contextLength?: number): Provider {
  switch (type) {
    case 'ollama':
      return new OllamaProvider({ baseUrl, contextLength })
    case 'lmstudio':
      return new OpenAICompatProvider({ name: 'lmstudio', baseUrl, apiKey: apiKey ?? '' })
    case 'llamacpp':
      return new OpenAICompatProvider({ name: 'llamacpp', baseUrl, apiKey: apiKey ?? '' })
    case 'vllm':
      return new OpenAICompatProvider({ name: 'vllm', baseUrl, apiKey: apiKey ?? '' })
    case 'openai-compat':
      return new OpenAICompatProvider({ name: 'custom', baseUrl, apiKey: apiKey ?? '' })
    default:
      return new OllamaProvider({ baseUrl })
  }
}
