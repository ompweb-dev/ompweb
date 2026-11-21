import { pickerAvailable } from "@/lib/cwd-picker";

// GET /api/cwd/picker → { available } — may this page open the server machine's folder dialog?
// Only a page opened on the machine itself: a remote browser has no desktop here. Locality is the
// connection's peer address from the server (context.localPeer), never request.url's host, which the
// client writes through its Host header.
export function GET(_request: Request, context: { localPeer: boolean }) {
  return Response.json({ available: pickerAvailable(context.localPeer) });
}
