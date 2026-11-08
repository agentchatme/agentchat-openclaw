/**
 * Key-shaped test values, built at run time so no secret-shaped literal sits
 * in the repository (GitHub secret scanning flags `ac_live_…` strings).
 */
export function testKey(tail: string): string {
  return ['ac', 'live', tail].join('_')
}
