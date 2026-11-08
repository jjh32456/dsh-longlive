/**
 * adapter 纯常量（不碰 fs / 不 import 第三方）：给纯函数模块用，保持纯度。
 * 第三方插件标识只允许出现在 src/adapters/** 内。
 */
export const EXTERNAL_PLUGIN_IDS = Object.freeze(['engram'])

/** 消息 source.kind 是否来自外部记忆插件的注入（如 plugin:dsh-* / 自定义注入）。 */
export function isExternalMemoryKind(kind) {
  if (typeof kind !== 'string' || kind === '') return false
  return EXTERNAL_PLUGIN_IDS.some((id) => kind.includes(id))
}
