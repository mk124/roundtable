/** Content-Security-Policy applied to every route as defence-in-depth beyond the
 *  DOM-construction safety boundary. */
export function cspHeader(): string {
  return "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
}
