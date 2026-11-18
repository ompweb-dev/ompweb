import { invalidateModelsCache } from "@/lib/models-cache";
import { getProviderUsageAccounts, renameProviderUsageAccount, updateProviderUsageAccount } from "@/lib/provider-usage";
import { saveWebServerSettings } from "@/lib/web-settings";
import { isRecord } from "@/lib/type-guards";

const PROVIDER_RE = /^[A-Za-z0-9._:/-]{1,200}$/;

export async function GET(request: Request) {
  try {
    return Response.json(await getProviderUsageAccounts(new URL(request.url).searchParams.get("refresh") === "true"));
  } catch {
    return Response.json(
      { error: "Provider usage is currently unavailable", code: "provider_usage_unavailable" },
      { status: 502 },
    );
  }
}

/**
 * Body `{ order }` saves the rows' order (`ProviderUsageAccount.key`s); `{ key, name }` names an account
 * (`name: null` or blank clears it); `{ provider, credentialId, paused?, limitPercent?, priority? }`
 * changes a stored one, `null` clearing a limit or priority.
 */
export async function PATCH(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
  if (body.order !== undefined) {
    const { order } = body;
    if (!Array.isArray(order) || order.length > 500 || order.some((key) => typeof key !== "string" || key.length > 300)) {
      return Response.json({ error: "order must be an array of at most 500 account keys" }, { status: 400 });
    }
    saveWebServerSettings({ accountOrder: order as string[] });
    return Response.json({ ok: true });
  }
  if (body.key !== undefined) {
    const { key, name } = body;
    if (typeof key !== "string" || key.length > 300 || (name !== null && (typeof name !== "string" || name.length > 80))) {
      return Response.json({ error: "key must be a string and name a string of at most 80 characters, or null" }, { status: 400 });
    }
    renameProviderUsageAccount(key, name);
    return Response.json({ ok: true });
  }
  const { provider, credentialId, paused, limitPercent, priority } = body;
  if (typeof provider !== "string" || !PROVIDER_RE.test(provider) || !Number.isSafeInteger(credentialId)) {
    return Response.json({ error: "provider and an integer credentialId are required" }, { status: 400 });
  }
  if (paused !== undefined && typeof paused !== "boolean") {
    return Response.json({ error: "paused must be a boolean" }, { status: 400 });
  }
  if (limitPercent !== undefined && limitPercent !== null
    && (!Number.isInteger(limitPercent) || (limitPercent as number) < 1 || (limitPercent as number) > 100)) {
    return Response.json({ error: "limitPercent must be an integer from 1 to 100, or null" }, { status: 400 });
  }
  if (priority !== undefined && priority !== null && (!Number.isInteger(priority) || Math.abs(priority as number) > 1000)) {
    return Response.json({ error: "priority must be an integer from -1000 to 1000, or null" }, { status: 400 });
  }
  try {
    await updateProviderUsageAccount(provider, credentialId as number, {
      ...(paused !== undefined ? { paused } : {}),
      ...(limitPercent !== undefined ? { limitPercent: limitPercent as number | null } : {}),
      ...(priority !== undefined ? { priority: priority as number | null } : {}),
    });
    if (paused !== undefined) invalidateModelsCache();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
