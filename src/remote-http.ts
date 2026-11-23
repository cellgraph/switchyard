import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  capabilities,
  instanceId,
  record,
  RemoteProtocolError,
  runtimeEvidence,
  sessionEvidence,
  string,
  turnEvidence,
  workerId,
  worktreeEvidence,
  worktreeLocation,
} from "./remote-protocol.ts";
import type { WorkflowStore } from "./store.ts";

const prefix = "/worker/v1/";
const bodyLimit = 256 * 1024;
const tokenPattern = /^[0-9a-f]{64}$/;

export function validWorkerToken(value: string) {
  return tokenPattern.test(value);
}

function authenticate(request: IncomingMessage, principals: ReadonlyMap<string, Buffer>): string {
  const id = request.headers["x-switchyard-worker"];
  const token = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.authorization ?? "")?.[1];
  const expected = typeof id === "string" ? principals.get(id) : undefined;
  if (
    typeof id !== "string" ||
    !token ||
    !expected ||
    !timingSafeEqual(expected, createHash("sha256").update(token).digest())
  )
    throw new RemoteProtocolError("Worker authentication failed.", 401);
  return id;
}

async function body(request: IncomingMessage) {
  if (request.headers["content-type"] !== "application/json")
    throw new RemoteProtocolError("Expected application/json.", 415);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > bodyLimit) throw new RemoteProtocolError("Request exceeds the size limit.", 413);
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RemoteProtocolError("Invalid JSON.");
  }
  return record(value);
}

function send(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}

export function createRemoteServer(
  store: ReturnType<WorkflowStore["remoteWorkers"]>,
  principals: ReadonlyMap<string, Buffer>,
  reportError: (error: unknown) => void,
) {
  return createServer(
    { requestTimeout: 10_000, headersTimeout: 5_000, connectionsCheckingInterval: 1000 },
    (request, response) => {
      async function handle() {
        if (request.method !== "POST" || !request.url?.startsWith(prefix))
          throw new RemoteProtocolError("Unknown endpoint.", 404);
        const id = authenticate(request, principals);
        const action = request.url.slice(prefix.length);
        const input = await body(request);
        if (action === "register") {
          store.register(id, capabilities(input.capabilities));
          return { registered: true };
        }
        const instance = instanceId(input.instance);
        if (action === "claim") return { task: store.claim(id, instance) };
        const key = {
          instance,
          operationId: string(input.operationId),
          fence: instanceId(input.fence),
        };
        switch (action) {
          case "start":
            if (
              store.start(id, key, runtimeEvidence(input.runtime), worktreeLocation(input.location))
            )
              return { started: true };
            break;
          case "launch":
            if (store.launch(id, key, worktreeEvidence(input.worktree))) return { launched: true };
            break;
          case "renew":
            if (
              store.renew(
                id,
                key,
                input.reference === undefined ? undefined : sessionEvidence(input.reference),
              )
            )
              return { renewed: true };
            break;
          case "complete": {
            const result = store.complete(id, key, turnEvidence(input.evidence));
            if (result === "conflict")
              throw new RemoteProtocolError(
                "A different terminal outcome is already recorded.",
                409,
              );
            return { result };
          }
          default:
            throw new RemoteProtocolError("Unknown endpoint.", 404);
        }
        throw new RemoteProtocolError("Execution lease is no longer active.", 409);
      }
      void handle().then(
        (result) => send(response, 200, result),
        (error: unknown) => {
          if (error instanceof RemoteProtocolError)
            send(response, error.status, { error: error.message });
          else {
            reportError(error);
            send(response, 500, { error: "Controller could not apply the request." });
          }
        },
      );
    },
  );
}

export function remoteControllerUrl(value: unknown): URL {
  const url = new URL(string(value, 4096));
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Use an HTTPS origin or a loopback HTTP origin over an SSH tunnel.");
  return url;
}

export function remoteClient(url: URL, id: string, token: string) {
  workerId(id);
  if (!validWorkerToken(token)) throw new Error("Invalid worker authentication token.");
  return async <T>(action: string, input: unknown): Promise<T> => {
    const response = await fetch(new URL(prefix + action, url), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      headers: {
        authorization: "Bearer " + token,
        "x-switchyard-worker": id,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new RemoteProtocolError(
        `Controller refused ${action} (HTTP ${response.status}).`,
        response.status,
      );
    }
    return (await response.json()) as T;
  };
}
