export type DeployOpts = {
  accountId: string;
  apiToken: string;
  scriptName: string;
  scriptModule: ArrayBuffer;
  compatibilityDate?: string;
  workerDomain?: string;
};

export type DeployResult = {
  deploy_id: string;
  url: string;
};

/**
 * Upload a Worker module via the CF Workers Scripts API.
 * Uses multipart/form-data with metadata + the worker.js module body.
 */
export async function deployWorker(opts: DeployOpts): Promise<DeployResult> {
  const fd = new FormData();
  fd.append(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: "worker.js",
          compatibility_date: opts.compatibilityDate ?? "2026-05-01",
          bindings: [],
        }),
      ],
      { type: "application/json" },
    ),
    "metadata",
  );
  fd.append(
    "worker.js",
    new Blob([opts.scriptModule], { type: "application/javascript+module" }),
    "worker.js",
  );

  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/workers/scripts/${encodeURIComponent(opts.scriptName)}`,
    {
      method: "PUT",
      headers: { authorization: `Bearer ${opts.apiToken}` },
      body: fd,
    },
  );
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`cf deploy ${r.status}: ${text.slice(0, 400)}`);
  }
  const data = (await r.json()) as {
    success: boolean;
    result?: { id?: string; etag?: string };
    errors?: { message: string }[];
  };
  if (!data.success) {
    throw new Error(`cf deploy failed: ${data.errors?.map((e) => e.message).join("; ") ?? "unknown"}`);
  }
  const deployId = data.result?.id ?? data.result?.etag ?? crypto.randomUUID();
  const url = opts.workerDomain
    ? `https://${opts.scriptName}.${opts.workerDomain}`
    : `https://${opts.scriptName}.workers.dev`;
  return { deploy_id: deployId, url };
}
