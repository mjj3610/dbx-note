/**
 * 多厂商多模型解析层
 *
 * 设置里存的是「厂商 → 模型列表 + 各用途的默认模型 id」，而 RPC 调用需要的是
 * 一份扁平的 `{ baseUrl, apiKey, model, temperature, ... }`。所有调用点都走这里，
 * 避免每个组件各自去 providers 里翻模型、各自拼参数。
 *
 * 与 NoteGen 的对应关系：`AiConfig` → `AiProvider`，`ModelConfig` → `AiModelConfig`，
 * `primaryModel` / 各用途默认模型 → `AiSettings.defaults`。
 */
import { useMemo } from 'react'

import type { AiConfig } from '@/lib/rpc'
import {
  useSettingsStore,
  type AiModelConfig,
  type AiModelType,
  type AiProvider,
  type AiSettings,
} from '@/stores/settings'

/** 内置厂商模板：新建厂商时一键填好名称与 baseURL，省去查文档 */
export interface ProviderTemplate {
  key: string
  name: string
  baseUrl: string
  /** 界面上的补充说明（是否需要本地服务等） */
  hint?: 'local'
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  { key: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { key: 'gemini', name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { key: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { key: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { key: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { key: 'moonshot', name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1' },
  { key: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1' },
  { key: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { key: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { key: 'together', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1' },
  { key: 'xai', name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1' },
  { key: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', hint: 'local' },
  { key: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', hint: 'local' },
  { key: 'custom', name: '', baseUrl: '' },
]

/** 解析结果：调用点需要的全部信息 */
export interface ResolvedModel {
  providerId: string
  providerName: string
  modelId: string
  /** 模型名，就是下发给接口的 `model` 字段 */
  modelName: string
  baseUrl: string
  apiKey: string
  modelType: AiModelType
  temperature: number
  topP: number
  enableStream: boolean
  maxTokens: number
  contextWindow: number
  voice: string
}

/** 同一个模型在看板上的展示值 */
export interface ModelOption {
  /** AiModelConfig.id */
  value: string
  /** 展示名：`厂商 / 模型名` */
  label: string
  providerId: string
  providerName: string
  model: AiModelConfig
}

function toResolved(provider: AiProvider, model: AiModelConfig): ResolvedModel {
  return {
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.id,
    modelName: model.name,
    baseUrl: provider.baseUrl.trim(),
    apiKey: provider.apiKey,
    modelType: model.modelType,
    temperature: model.temperature,
    topP: model.topP,
    enableStream: model.enableStream,
    maxTokens: model.maxTokens,
    contextWindow: model.contextWindow,
    voice: model.voice,
  }
}

/** 按 id 找模型（跨厂商），找不到返回 null */
export function findModel(
  ai: AiSettings,
  modelId: string | undefined,
): { provider: AiProvider; model: AiModelConfig } | null {
  if (!modelId) return null
  for (const provider of ai.providers) {
    const model = provider.models.find((item) => item.id === modelId)
    if (model) return { provider, model }
  }
  return null
}

/** 列出某用途的全部模型，按厂商分组顺序展开 */
export function listModels(ai: AiSettings, type: AiModelType): ModelOption[] {
  const options: ModelOption[] = []
  for (const provider of ai.providers) {
    for (const model of provider.models) {
      if (model.modelType !== type) continue
      options.push({
        value: model.id,
        label: `${provider.name || provider.baseUrl || '未命名厂商'} / ${model.name || '未命名模型'}`,
        providerId: provider.id,
        providerName: provider.name,
        model,
      })
    }
  }
  return options
}

/**
 * 按用途解析出实际要调用的模型。
 *
 * 优先用 `defaults[type]`；该 id 失效时退化为同类第一个模型。
 * 因此即使默认值指向已删除的模型，功能也不会突然失效。
 */
export function resolveModel(
  ai: AiSettings,
  options: { type: AiModelType; modelId?: string },
): ResolvedModel | null {
  const preferred = findModel(ai, options.modelId ?? ai.defaults[options.type])
  if (preferred && preferred.model.modelType === options.type) {
    return toResolved(preferred.provider, preferred.model)
  }
  // 没有匹配到指定用途时，退化为第一个可用的同类模型
  for (const provider of ai.providers) {
    const model = provider.models.find((item) => item.modelType === options.type)
    if (model) return toResolved(provider, model)
  }
  return null
}

/**
 * 转成 RPC 参数。
 *
 * 只带有效字段：`maxTokens` 为 0 时不发 `max_tokens`，避免覆盖服务端默认；
 * `topP` 为 1 时也不发，减少对模型的额外约束。
 */
export function toRpcConfig(
  resolved: ResolvedModel,
  extra: { maxTokens?: number } = {},
): AiConfig & { topP?: number; maxTokens?: number } {
  const maxTokens = extra.maxTokens ?? resolved.maxTokens
  return {
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    model: resolved.modelName,
    temperature: resolved.temperature,
    ...(resolved.topP > 0 && resolved.topP !== 1 ? { topP: resolved.topP } : {}),
    ...(maxTokens > 0 ? { maxTokens } : {}),
  }
}

/**
 * 解析某用途的模型；该用途没有配置时退化为「对话」模型。
 *
 * 为什么需要：升级前只有一个模型，图片识别与语音转写都复用它。若升级后严格按用途查找，
 * 只配过一个多模态模型的用户会突然发现识别功能失效。这里显式回退，行为与旧版一致。
 */
export function resolveModelWithFallback(
  ai: AiSettings,
  type: AiModelType,
): ResolvedModel | null {
  return resolveModel(ai, { type }) ?? resolveModel(ai, { type: 'chat' })
}

/** 该用途是否已经具备可用配置（地址 + 模型名都非空） */
export function isModelReady(resolved: ResolvedModel | null): resolved is ResolvedModel {
  return Boolean(resolved && resolved.baseUrl && resolved.modelName)
}

/** 订阅某用途的默认模型 */
export function useResolvedModel(type: AiModelType): ResolvedModel | null {
  const ai = useSettingsStore((state) => state.ai)
  return useMemo(() => resolveModel(ai, { type }), [ai, type])
}

/** 订阅某用途的可选模型列表，用于下拉框 */
export function useModelOptions(type: AiModelType): ModelOption[] {
  const ai = useSettingsStore((state) => state.ai)
  return useMemo(() => listModels(ai, type), [ai, type])
}

/** 订阅全部模型（用于对话面板的模型切换器） */
export function useAllModels(): ModelOption[] {
  const ai = useSettingsStore((state) => state.ai)
  return useMemo(
    () =>
      ai.providers.flatMap((provider) =>
        provider.models.map((model) => ({
          value: model.id,
          label: `${provider.name || provider.baseUrl || '未命名厂商'} / ${model.name || '未命名模型'}`,
          providerId: provider.id,
          providerName: provider.name,
          model,
        })),
      ),
    [ai],
  )
}
