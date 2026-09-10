export const MAX_PROVIDER_MODELS = 1000;

export function mergeModelInput(current: string[], input: string): { models: string[]; added: number; error?: never } | { error: string; models?: never; added?: never } {
  const incoming = input.split(/[,，\s]+/).filter(Boolean);
  const invalid = incoming.find(model => model.length > 160 || !/^[a-zA-Z0-9@][a-zA-Z0-9._:/-]*$/.test(model));
  if (invalid) return { error: `模型 ID「${invalid.slice(0, 40)}${invalid.length > 40 ? '…' : ''}」无效：最多 160 个字符，仅支持字母、数字、点、下划线、斜线、短横线，首字符也可为 @。` };
  const models = [...new Set([...current, ...incoming])];
  if (models.length > MAX_PROVIDER_MODELS) return { error: `最多添加 ${MAX_PROVIDER_MODELS} 个模型，本次添加后为 ${models.length} 个。请减少后重试。` };
  return { models, added: models.length - current.length };
}
