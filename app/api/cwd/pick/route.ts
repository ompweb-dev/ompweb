import { apiErrorResponse } from "@/lib/api-utils";
import { pickDirectory, pickerAvailable } from "@/lib/cwd-picker";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";

// POST /api/cwd/pick  body: { hostId?: string } → { path } | { cancelled: true }
// Opens the OS folder dialog on this machine. A page opened from another machine has no desktop
// here, and another host's paths do not exist here either, so both cases are refused.
export async function POST(req: Request, context: { localPeer: boolean }) {
  try {
    const body = await req.json().catch(() => ({})) as { hostId?: unknown };
    const hostId = typeof body.hostId === "string" && body.hostId ? body.hostId : LOCAL_HOST_ID;
    const picked = hostId === LOCAL_HOST_ID && pickerAvailable(context.localPeer) ? await pickDirectory() : null;
    if (!picked) {
      return Response.json({ error: "The folder dialog is only available on this machine", code: "picker_unavailable" }, { status: 501 });
    }
    return Response.json(picked);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
