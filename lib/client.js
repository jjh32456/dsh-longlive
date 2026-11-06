// Browser half of the longlive settings panel.
//
// The client module system materializes this factory on first import, so every
// side effect (including the slot registration) lives inside `apply`. The panel
// talks to the Host through the same-origin JSON route registered by
// src/ui/routes.js — a Cordis client bundle cannot import Node modules and the
// Host's `settings` service only accepts volatile fields, so a plugin-owned
// route is the supported write path for ordinary config keys.
window.__ModuleLoader__.load({
  id: "dsh-longlive",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const ENDPOINT = "/api/longlive/flags";
    const SLOT = "plugins.row.config";
    const SLOT_KEY = "dsh-longlive#session-longlive";
    const PANEL_TITLE = "久视 · 功能开关";

    function messageOf(error) {
      if (error === null || error === undefined) return "未知错误";
      if (typeof error === "string") return error;
      if (typeof error.message === "string" && error.message !== "") return error.message;
      return String(error);
    }

    function findSwitch(data, key) {
      const groups = data && Array.isArray(data.groups) ? data.groups : [];
      for (const group of groups) {
        const switches = group && Array.isArray(group.switches) ? group.switches : [];
        for (const item of switches) {
          if (item && item.key === key) return item;
        }
      }
      return undefined;
    }

    /**
     * One GET/POST against the Host route. A non-2xx or `{ok:false}` response is
     * an error carrying the Host's own reason; the controller rolls the switch
     * back and shows it verbatim.
     */
    async function request(method, body) {
      let response;
      try {
        response = await fetch(ENDPOINT, {
          method,
          headers: body === undefined
            ? { accept: "application/json" }
            : { accept: "application/json", "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: "same-origin",
          cache: "no-store",
        });
      } catch (error) {
        throw new Error(`无法连接宿主接口（${ENDPOINT}）：${messageOf(error)}`);
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || payload === null || payload.ok === false) {
        if (response.status === 404) {
          throw new Error(`宿主没有注册 ${ENDPOINT}（webServer 不可用或插件未加载）。`);
        }
        const reason = payload && typeof payload.error === "string" && payload.error !== ""
          ? payload.error
          : `HTTP ${response.status}`;
        throw new Error(reason);
      }
      return payload;
    }

    /**
     * Pure state machine behind the panel: read defaults, flip optimistically,
     * persist, and roll the UI back with the Host's reason on failure. This is
     * exported for the unit tests; the browser only uses it through the panel.
     */
    function createFlagsController(options) {
      const load = options.load;
      const save = options.save;
      let disposed = false;
      let refreshing = false;
      let state = {
        status: "loading",
        error: null,
        data: null,
        values: {},
        pending: {},
        failures: {},
      };
      const listeners = new Set();

      function emit(patch) {
        state = Object.assign({}, state, patch);
        for (const listener of Array.from(listeners)) {
          try {
            listener();
          } catch {
            /* a broken subscriber must not break the panel */
          }
        }
      }

      function subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }

      function getSnapshot() {
        return state;
      }

      function dispose() {
        disposed = true;
        listeners.clear();
      }

      async function refresh() {
        if (disposed || refreshing) return;
        refreshing = true;
        emit({ status: state.data === null ? "loading" : state.status, error: null });
        try {
          const data = await load();
          if (disposed) return;
          const values = {};
          const pending = {};
          const groups = data && Array.isArray(data.groups) ? data.groups : [];
          for (const group of groups) {
            for (const item of group.switches || []) {
              values[item.key] = item.value === true;
              pending[item.key] = false;
            }
          }
          emit({ status: "ready", data, values, pending, failures: {}, error: null });
        } catch (error) {
          if (disposed) return;
          emit({ status: state.data === null ? "error" : "ready", error: messageOf(error) });
        } finally {
          refreshing = false;
        }
      }

      async function setFlag(key, next) {
        if (disposed) return { ok: false, error: "面板已关闭" };
        const descriptor = findSwitch(state.data, key);
        if (descriptor === undefined) return { ok: false, error: `未知的功能开关：${key}` };
        if (state.data && state.data.writable === false) {
          return { ok: false, error: "当前宿主不允许写入插件配置，面板只读。" };
        }
        if (descriptor.readOnly === true) return { ok: false, error: `${descriptor.label || key} 是只读字段。` };
        if (state.pending[key] === true) return { ok: false, error: "上一次保存还没结束。" };
        const value = next === true;
        const previous = state.values[key] === true;
        if (previous === value) return { ok: true, value };
        emit({
          values: Object.assign({}, state.values, { [key]: value }),
          pending: Object.assign({}, state.pending, { [key]: true }),
          failures: Object.assign({}, state.failures, { [key]: null }),
          error: null,
        });
        try {
          await save(key, value);
          if (disposed) return { ok: true, value };
          emit({ pending: Object.assign({}, state.pending, { [key]: false }) });
          return { ok: true, value };
        } catch (error) {
          if (disposed) return { ok: false, error: messageOf(error) };
          const reason = messageOf(error);
          emit({
            values: Object.assign({}, state.values, { [key]: previous }),
            pending: Object.assign({}, state.pending, { [key]: false }),
            failures: Object.assign({}, state.failures, { [key]: reason }),
            error: null,
          });
          return { ok: false, error: reason };
        }
      }

      function toggle(key) {
        return setFlag(key, !(state.values[key] === true));
      }

      return { getSnapshot, subscribe, refresh, setFlag, toggle, dispose };
    }

    const useStore = typeof react.useSyncExternalStore === "function"
      ? react.useSyncExternalStore
      : function fallbackUseStore(subscribe, getSnapshot) {
        const [snapshot, setSnapshot] = react.useState(getSnapshot);
        react.useEffect(() => {
          setSnapshot(getSnapshot());
          return subscribe(() => setSnapshot(getSnapshot()));
        }, []);
        return snapshot;
      };

    function makePanel(controller) {
      const h = react.createElement;

      const pageStyle = {
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        maxWidth: "720px",
        fontSize: "14px",
        lineHeight: "1.5",
        color: "var(--dsw-alias-label-primary, #1f2328)",
      };
      const mutedStyle = { color: "var(--dsw-alias-label-secondary, #6b7280)", fontSize: "12px" };
      const groupStyle = {
        border: "1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.22))",
        borderRadius: "10px",
        padding: "2px 14px",
      };
      const groupHeadingStyle = {
        margin: "12px 0 4px",
        fontSize: "12px",
        fontWeight: "600",
        letterSpacing: ".04em",
        color: "var(--dsw-alias-label-secondary, #6b7280)",
      };
      const rowStyle = {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "20px",
        padding: "12px 0",
        borderTop: "1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.14))",
      };
      const labelStyle = { fontWeight: "600", marginBottom: "2px" };
      const descStyle = { ...mutedStyle, lineHeight: "1.45" };
      const failureStyle = { color: "var(--dsw-alias-label-danger, #b42318)", fontSize: "12px", marginTop: "4px" };
      const bannerStyle = {
        border: "1px solid var(--dsw-alias-border-danger, rgba(180,35,24,.4))",
        background: "var(--dsw-alias-bg-danger, rgba(180,35,24,.08))",
        color: "var(--dsw-alias-label-danger, #b42318)",
        borderRadius: "8px",
        padding: "10px 12px",
        fontSize: "13px",
      };
      const readOnlyStyle = {
        border: "1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.22))",
        borderRadius: "8px",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
      };
      const buttonStyle = {
        marginTop: "8px",
        alignSelf: "flex-start",
        border: "1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.35))",
        background: "transparent",
        color: "inherit",
        borderRadius: "6px",
        padding: "4px 10px",
        fontSize: "12px",
        cursor: "pointer",
      };

      function switchStyle(on, disabled) {
        return {
          flex: "0 0 auto",
          width: "42px",
          height: "24px",
          borderRadius: "999px",
          border: "1px solid transparent",
          padding: "2px",
          margin: "0",
          boxSizing: "border-box",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: on ? "flex-end" : "flex-start",
          background: on ? "#2f6fed" : "rgba(127,127,127,.35)",
          opacity: disabled ? 0.55 : 1,
          cursor: disabled ? "not-allowed" : "pointer",
          transition: "background-color .15s ease",
        };
      }

      const knobStyle = {
        width: "18px",
        height: "18px",
        borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 1px 2px rgba(0,0,0,.25)",
        display: "block",
      };

      function Summary() {
        const state = useStore(controller.subscribe, controller.getSnapshot);
        react.useEffect(() => {
          if (state.status === "loading" && state.data === null) controller.refresh();
        }, []);
        const groups = state.data && Array.isArray(state.data.groups) ? state.data.groups : [];
        let total = 0;
        let enabled = 0;
        for (const group of groups) {
          for (const item of group.switches || []) {
            total += 1;
            if (state.values[item.key] === true) enabled += 1;
          }
        }
        const text = state.status === "error"
          ? "面板不可用"
          : state.status === "ready"
            ? `${enabled}/${total} 已开启`
            : "加载中…";
        return h("span", { style: mutedStyle }, `${PANEL_TITLE}：${text}`);
      }

      function Panel(props) {
        const state = useStore(controller.subscribe, controller.getSnapshot);
        react.useEffect(() => {
          if (state.status === "loading" && state.data === null) controller.refresh();
        }, []);
        if (props && props.view === "summary") return h(Summary, null);

        const data = state.data;
        const groups = data && Array.isArray(data.groups) ? data.groups : [];
        const rows = [];
        rows.push(h("h3", {
          key: "title",
          style: { margin: "0", fontSize: "16px", fontWeight: "650" },
        }, PANEL_TITLE));
        rows.push(h("p", {
          key: "hint",
          style: { margin: "0", ...mutedStyle },
        }, "开关写入当前 profile 的插件配置；保存后插件会按新配置重载。"));
        if (state.error !== null) {
          rows.push(h("div", { key: "error", role: "alert", style: bannerStyle }, state.error));
        }
        if (data && data.writable === false) {
          rows.push(h("div", {
            key: "readonly",
            role: "status",
            style: { ...bannerStyle, borderColor: "var(--dsw-alias-border-secondary, rgba(127,127,127,.35))", background: "transparent", color: "inherit" },
          }, "当前宿主不允许写入插件配置（configEditor 或配置行不可用），面板只读。"));
        }
        rows.push(h("div", { key: "root", style: readOnlyStyle }, [
          h("div", { key: "label", style: { ...mutedStyle, fontWeight: "600" } }, "记忆根目录（只读）"),
          h("code", { key: "value", style: { fontSize: "12px", wordBreak: "break-all" } }, data && data.memoryRoot ? data.memoryRoot : "未解析"),
        ]));
        for (const group of groups) {
          const switches = group.switches || [];
          const items = switches.map((item) => {
            const on = state.values[item.key] === true;
            const pending = state.pending[item.key] === true;
            const failure = state.failures[item.key];
            const disabled = pending || state.status !== "ready" || (data && data.writable === false) || item.readOnly === true;
            const details = [
              h("div", { key: "label", style: labelStyle }, item.label),
              h("div", { key: "desc", style: descStyle }, item.description),
            ];
            if (pending) details.push(h("div", { key: "pending", style: mutedStyle }, "保存中…"));
            if (failure) details.push(h("div", { key: "failure", role: "status", style: failureStyle }, `保存失败：${failure}`));
            return h("div", { key: item.key, style: rowStyle }, [
              h("div", { key: "text", style: { minWidth: "0" } }, details),
              h("button", {
                key: "switch",
                type: "button",
                role: "switch",
                "aria-checked": on,
                "aria-label": item.label,
                disabled,
                onClick: () => { controller.toggle(item.key); },
                style: switchStyle(on, disabled),
              }, h("span", { style: knobStyle })),
            ]);
          });
          rows.push(h("section", { key: group.id, style: groupStyle }, [
            h("div", { key: "heading", style: groupHeadingStyle }, group.label),
            ...items,
          ]));
        }
        rows.push(h("button", {
          key: "refresh",
          type: "button",
          onClick: () => { controller.refresh(); },
          style: buttonStyle,
        }, state.status === "loading" ? "刷新中…" : "刷新"));
        return h("div", { style: pageStyle }, rows);
      }

      return Panel;
    }

    const inject = ["slots"];

    function apply(ctx) {
      const controller = createFlagsController({
        load: () => request("GET"),
        save: (key, value) => request("POST", { key, value }),
      });
      const Panel = makePanel(controller);
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function" || typeof ctx.slots.register !== "function") {
        controller.dispose();
        return;
      }
      let disposeSlot;
      const disposeWatch = ctx.slots.inject(SLOT, () => {
        disposeSlot = ctx.slots.register({ name: SLOT, key: SLOT_KEY }, Panel);
        return disposeSlot;
      });
      if (typeof ctx.effect === "function") {
        ctx.effect(() => () => {
          try {
            if (typeof disposeSlot === "function") disposeSlot();
          } catch {
            /* already disposed */
          }
          try {
            if (typeof disposeWatch === "function") disposeWatch();
          } catch {
            /* already disposed */
          }
          controller.dispose();
        }, "longlive: settings panel");
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.createFlagsController = createFlagsController;
    exports.PANEL_TITLE = PANEL_TITLE;
    exports.SLOT_KEY = SLOT_KEY;
    return module.exports;
  },
});
