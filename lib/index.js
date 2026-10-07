//#region lib/types/index.js
/**
 * Balance badge plugin - node half.
 *
 * Pure UI plugin: the empty `apply` exists so the package appears in the Host
 * Loader tree; the browser half ships through `exports["./client"]` and is
 * discovered through the package.json `dsh.client` declaration. Balance reads
 * ride the already-shipped `accountController` Remote (`ctx.remote.account`),
 * so this package owns no Host service and no credentials.
 */
/** Host plugin body - no host-side behavior for this surface plugin. */
function apply() {}
//#endregion
export { apply };