import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { object, positiveInteger, repositoryName } from "./github-data.ts";

export type ReconcileHint = {
  repository: string;
  installationId: number;
  pullRequest: number | null;
};

class InvalidDelivery extends Error {
  readonly status: number;

  constructor(status: number) {
    super("Invalid GitHub webhook delivery.");
    this.status = status;
  }
}

const lifecycleActions = new Set([
  "opened",
  "reopened",
  "synchronize",
  "closed",
  "ready_for_review",
  "converted_to_draft",
]);
const reviewActions = new Set(["submitted", "edited", "dismissed"]);
const commentActions = new Set(["created", "edited", "deleted"]);

function normalize(event: string, payload: Record<string, unknown>): ReconcileHint | null {
  const action = typeof payload.action === "string" ? payload.action : "";
  let pullRequest: unknown;
  switch (event) {
    case "pull_request":
      if (!lifecycleActions.has(action)) return null;
      pullRequest = payload.number;
      break;
    case "pull_request_review":
    case "pull_request_review_comment":
      if (!(event === "pull_request_review" ? reviewActions : commentActions).has(action))
        return null;
      pullRequest = object(payload.pull_request)?.number;
      break;
    case "issue_comment": {
      const issue = object(payload.issue);
      if (!commentActions.has(action) || !object(issue?.pull_request)) return null;
      pullRequest = issue?.number;
      break;
    }
    case "check_run":
    case "check_suite": {
      const associated = object(payload[event])?.pull_requests;
      const number =
        Array.isArray(associated) && associated.length === 1
          ? object(associated[0])?.number
          : undefined;
      pullRequest = positiveInteger(number) ? number : null;
      break;
    }
    case "status":
      pullRequest = null;
      break;
    default:
      return null;
  }
  const hint = {
    repository: repositoryName(object(payload.repository)?.full_name),
    installationId: object(payload.installation)?.id,
    pullRequest,
  };
  if (!validHint(hint)) throw new InvalidDelivery(400);
  return hint;
}

function validHint(value: unknown): value is ReconcileHint {
  const hint = object(value);
  return (
    !!hint &&
    typeof hint.repository === "string" &&
    repositoryName(hint.repository) === hint.repository &&
    positiveInteger(hint.installationId) &&
    (hint.pullRequest === null || positiveInteger(hint.pullRequest))
  );
}

function header(request: IncomingMessage, name: string): string | undefined {
  const values = request.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  if (Number(request.headers["content-length"]) > limit) throw new InvalidDelivery(413);
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = chunk as Buffer;
    length += bytes.length;
    if (length > limit) throw new InvalidDelivery(413);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

export function createWebhookServer({
  secret,
  notify,
  reportError,
  maxBodyBytes = 25 * 1024 * 1024,
}: {
  secret: string;
  notify: (hint: ReconcileHint) => void;
  reportError: (message: string) => void;
  maxBodyBytes?: number;
}) {
  if (!secret) throw new Error("A GitHub webhook secret is required.");
  const route = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.url !== "/webhooks/github") {
      response.writeHead(404, { connection: "close" }).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST", connection: "close" }).end();
      return;
    }

    try {
      const signature = header(request, "x-hub-signature-256");
      if (!signature || signature.length !== 71 || !/^sha256=[0-9a-f]{64}$/.test(signature))
        throw new InvalidDelivery(401);
      const deliveryId = header(request, "x-github-delivery");
      if (
        !deliveryId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deliveryId)
      )
        throw new InvalidDelivery(400);
      const event = header(request, "x-github-event");
      if (!event || !/^[a-z][a-z0-9_]{0,63}$/.test(event)) throw new InvalidDelivery(400);
      const body = await readBody(request, maxBodyBytes);
      const expected = createHmac("sha256", secret).update(body).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex")))
        throw new InvalidDelivery(401);

      let payload: Record<string, unknown> | undefined;
      try {
        payload = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
      } catch {
        throw new InvalidDelivery(400);
      }
      if (!payload) throw new InvalidDelivery(400);
      const hint = normalize(event, payload);
      if (hint) notify(hint);
      response.writeHead(202).end();
    } catch (error) {
      const status = error instanceof InvalidDelivery ? error.status : 503;
      if (status === 503) reportError("Unable to signal GitHub reconciliation.");
      response.writeHead(status, { connection: "close" }).end();
    }
  };
  return createServer(
    { requestTimeout: 10_000, headersTimeout: 5_000, connectionsCheckingInterval: 1000 },
    (request, response) => void route(request, response),
  );
}
