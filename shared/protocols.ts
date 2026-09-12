export const PROTOCOL_PATHS = {
  openai: 'chat/completions',
  anthropic: 'messages',
  responses: 'responses',
} as const;

export type Protocol = keyof typeof PROTOCOL_PATHS;

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  responses: 'OpenAI Responses',
};

export const PROTOCOL_FULL_LABELS: Record<Protocol, string> = {
  openai: 'OpenAI Chat Completions',
  anthropic: 'Anthropic Messages',
  responses: 'OpenAI Responses',
};
