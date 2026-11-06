/**
 * pre-step 容器 fixture —— 复刻真实 Cordis 的 waterfall 合成语义。
 *
 * 依据（asar 解包的宿主代码）：
 *   - `@deepseek-ai/cordis` src/events.ts:234-242
 *       const cbs = this.dispatch('waterfall', args)
 *       const inner = args.pop()
 *       const next = () => (cbs.shift() ?? inner)(...args)
 *       args.push(next); return next()
 *   - 同文件 :255  `const method = options.prepend ? 'unshift' : 'push'`
 *   - 宿主 `dsh-agent-loop/lib/index.js:902-926`：
 *       const claimed = this.inbox.claim(target, position.turn)
 *       dispatch.waterfall('agent/pre-step', { messages: claimed, ... }, () =>
 *         ({ kind: 'enter', messages: context === undefined ? claimed : [...claimed, context] }))
 *
 * 注意：listener 收到的是 `(payload, next)`，且所有 listener 共用同一个 next
 * 闭包；inner 闭包引用的是同一个 claimed 数组。所以 identity-router 在
 * `next()` 之前原地把开机卡插到第一条真实 user 之后，内层才看得到。v3 起开机卡
 * 不再 unshift 到最前（TurnNavigator 取该轮第一个 kind==='user' 节点当 tooltip）。
 *
 * 这个 fixture 不是手拼顺序数组：测试只给输入消息 + runtime context，顺序完全由
 * 注册语义和插件代码合成。
 */

export class PreStepBus {
  constructor() {
    /** @type {Map<string, Function[]>} */
    this.hooks = new Map();
  }

  on(name, listener, options = {}) {
    if (typeof listener !== 'function') throw new TypeError(`listener for ${name} must be a function`);
    const list = this.hooks.get(name) ?? [];
    const prepend = typeof options === 'boolean' ? options : options?.prepend === true;
    if (prepend) list.unshift(listener);
    else list.push(listener);
    this.hooks.set(name, list);
    return () => {
      const index = list.indexOf(listener);
      if (index !== -1) list.splice(index, 1);
      return index !== -1;
    };
  }

  /** 真实 Cordis waterfall：外层先跑，next 共享。 */
  async waterfall(name, payload, inner) {
    const cbs = [...(this.hooks.get(name) ?? [])];
    const next = () => {
      const cb = cbs.shift() ?? inner;
      return cb(payload, next);
    };
    return next();
  }

  /**
   * 合成一次 pre-step，返回宿主最终会消费的 decision 和 claimed 数组。
   * @param {{messages:object[], agent?:object, turn?:number, step?:number, context?:object}} input
   */
  async compose({ messages, agent, turn = 1, step = 1, context } = {}) {
    const claimed = Array.isArray(messages) ? [...messages] : [];
    const inner = () => (context === undefined
      ? { kind: 'enter', messages: claimed }
      : { kind: 'enter', messages: [...claimed, context] });
    const decision = await this.waterfall(
      'agent/pre-step',
      { messages: claimed, agent, turn, step },
      inner,
    );
    return { decision, claimed };
  }

  /** 给 session/event 之类的普通事件用。 */
  async emit(name, ...args) {
    for (const listener of [...(this.hooks.get(name) ?? [])]) {
      await listener(...args);
    }
  }
}

/** 与宿主 createUserMessage 同形的最小工厂（冻结消息，防插件原地改消息）。 */
export function makeUserMessageFactory(prefix = 'msg') {
  let seq = 0;
  return ({ content, source }) => {
    seq += 1;
    return Object.freeze({
      role: 'user',
      content,
      source,
      id: `${prefix}-${seq}`,
    });
  };
}

export function textMessage(text, { role = 'user', source = { kind: 'user' }, id } = {}) {
  return { role, content: [{ type: 'text', text }], source, ...(id ? { id } : {}) };
}

export function noopLogger() {
  return { warn() {}, info() {}, error() {} };
}
