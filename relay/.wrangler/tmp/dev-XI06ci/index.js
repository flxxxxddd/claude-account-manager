var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var ROUTE = /^\/v1\/(daemon|client)\/([a-f0-9]{16,64})$/;
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "cca-remote-relay" });
    const match = ROUTE.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const deviceId = match[2];
    const room = env.ROOMS.get(env.ROOMS.idFromName(deviceId));
    return room.fetch(request);
  }
};
async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256, "sha256");
var Room = class {
  constructor(state, _env) {
    this.state = state;
  }
  state;
  static {
    __name(this, "Room");
  }
  async fetch(request) {
    const url = new URL(request.url);
    const match = ROUTE.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });
    const role = match[1];
    const token = url.searchParams.get("token") ?? bearer(request);
    if (!token) return new Response("missing token", { status: 401 });
    const ok = role === "daemon" ? await this.authDaemon(token, url.searchParams.get("clientToken")) : await this.authClient(token);
    if (!ok) return new Response("unauthorized", { status: 401 });
    if (role === "daemon" && this.daemon()) {
      for (const ws of this.state.getWebSockets("daemon")) ws.close(4e3, "replaced by a newer daemon connection");
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const id = crypto.randomUUID().slice(0, 8);
    this.state.acceptWebSocket(server, [role, role === "client" ? `client:${id}` : "daemon"]);
    server.serializeAttachment({ role, id });
    if (role === "client") {
      this.daemon()?.send(JSON.stringify({ sys: "client_open", c: id }));
      if (!this.daemon()) server.send(JSON.stringify({ sys: "error", message: "daemon offline" }));
    } else {
      for (const ws of this.state.getWebSockets("client")) {
        const att = ws.deserializeAttachment();
        server.send(JSON.stringify({ sys: "client_open", c: att.id }));
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  /**
   * First daemon claims the room. `clientToken` travels alongside so the room
   * can verify phones without ever seeing the pairing key.
   */
  async authDaemon(token, clientToken) {
    const stored = await this.state.storage.get("daemonHash");
    const hash = await sha256(token);
    if (!stored) {
      if (!clientToken) return false;
      await this.state.storage.put({ daemonHash: hash, clientHash: await sha256(clientToken), claimedAt: Date.now() });
      return true;
    }
    if (stored !== hash) return false;
    if (clientToken) await this.state.storage.put("clientHash", await sha256(clientToken));
    return true;
  }
  async authClient(token) {
    const stored = await this.state.storage.get("clientHash");
    return stored !== void 0 && stored === await sha256(token);
  }
  daemon() {
    return this.state.getWebSockets("daemon")[0];
  }
  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment();
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (text.length > 4e6) {
      ws.close(1009, "frame too large");
      return;
    }
    if (att.role === "client") {
      const daemon = this.daemon();
      if (!daemon) {
        ws.send(JSON.stringify({ sys: "error", message: "daemon offline" }));
        return;
      }
      let frame2;
      try {
        frame2 = JSON.parse(text);
      } catch {
        return;
      }
      daemon.send(JSON.stringify({ c: att.id, e: frame2.e }));
      return;
    }
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame.c === "*") {
      for (const client of this.state.getWebSockets("client")) client.send(JSON.stringify({ e: frame.e }));
      return;
    }
    if (!frame.c) return;
    const target = this.state.getWebSockets(`client:${frame.c}`)[0];
    target?.send(JSON.stringify({ e: frame.e }));
  }
  async webSocketClose(ws, code, reason) {
    const att = ws.deserializeAttachment();
    if (att.role === "client") {
      this.daemon()?.send(JSON.stringify({ sys: "client_close", c: att.id }));
    } else {
      for (const client of this.state.getWebSockets("client")) {
        client.send(JSON.stringify({ sys: "error", message: `daemon offline (${code}${reason ? ` ${reason}` : ""})` }));
      }
    }
    ws.close(code, reason);
  }
  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011, "error");
  }
};
function bearer(request) {
  const header = request.headers.get("Authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}
__name(bearer, "bearer");

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-kceFkm/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-kceFkm/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Room,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
