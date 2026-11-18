// Not a test file itself. Tests that route a legacy daemon's update must not depend on what GitHub serves today.
// Before this build's release is published its lookup fails; afterwards it succeeds and an old daemon gains a Force
// (recovery) route. Stubbing the lookup pins the production state: the recovery helper is published and available.

/** Answer the release lookup of this build with a published release; every other request goes to the real fetch.
 * Returns the function that restores `fetch`. */
export function stubRecoveryRelease() {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/tags\//.test(url)) return real(input, init);
    const { installedRecoveryTag } = await import("../recovery-release.ts");
    const assets = ["linux-x64.tar.gz", "darwin-arm64.tar.gz", "windows-x64.zip"].map((name) => ({ name: `ompweb-${name}`, digest: `sha256:${"a".repeat(64)}` }));
    return Response.json({ tag_name: installedRecoveryTag(), assets });
  };
  return () => { globalThis.fetch = real; };
}
