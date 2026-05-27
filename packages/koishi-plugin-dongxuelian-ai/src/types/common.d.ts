export interface ChatConfig {
  model: string
  baseURL: string
  apiKey: string
  provider: string
}

export interface MessageEntry {
  role: string
  content: string
  userId?: string
  timestamp?: number
}
