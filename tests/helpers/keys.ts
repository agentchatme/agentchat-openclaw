/**
 * Key-shaped test values (`ac_` + a tail), built at run time so no
 * secret-shaped literal sits in the repository: a real key is `ac_` + 32
 * random bytes as base64url, which the secret scan (.gitleaks.toml) flags.
 */
export function testKey(tail: string): string {
  return ['ac', tail].join('_')
}
