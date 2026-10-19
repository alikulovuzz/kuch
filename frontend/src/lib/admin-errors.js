// Stable server codes become operator-facing copy before the admin locale renders it.
const messages = {
  'bad-credentials': 'Wrong name, email, or password.',
  'current-required': 'Enter your current password or confirm with another sign-in method.',
  'current-wrong': 'Your current password is not right.',
  'passkey': 'Your passkey could not be confirmed.',
  'passkey-required': 'Confirm with an existing passkey or Google.',
  'last-way-in': 'Keep another usable sign-in method before removing this one.',
  'too-short': 'Use at least 10 characters.',
  'too-long': 'That password is too long.',
  'too-common': 'Choose a less predictable password.',
  'email-invalid': 'Enter a valid email address.',
  'email-taken': 'This email address cannot be used for this profile.',
  'name-taken': 'This profile name conflicts with another sign-in identifier. Contact the server operator.',
  'mail-unavailable': 'Outgoing mail is not configured. Contact the server operator or use another sign-in method.',
  'mail-failed': 'The email could not be delivered. Wait before sending another link.',
  'token-invalid': 'This link is invalid, expired, or already used. Request a new link.',
  'password-unavailable': 'Password sign-in is unavailable on this server.',
  'google-unavailable': 'Google sign-in is unavailable on this server.',
  'google-unlinked': 'This Google account is not linked to a Kuch profile. Sign in with an existing method first.',
  'google-conflict': 'This Google account cannot be linked to this profile. Try another account.',
  'google-failed': 'Google sign-in could not be completed. Try again or use another method.',
  'google-cancelled': 'Google sign-in was cancelled.',
  'google-proof-expired': 'Your identity confirmation expired. Sign in and try again.',
  'google-state': 'The sign-in request expired or belongs to another browser. Start again.',
  'disabled': 'This account has been disabled.',
  'locked': 'Too many attempts. Wait before trying again.',
  'busy': 'The server is busy. Try again in a moment.',
  'passkey-limit': 'This profile has reached its passkey limit.',
  'credential-exists': 'This passkey already belongs to a profile.',
  'no such user': 'This profile no longer exists. Refresh the user list.',
  'cannot disable an admin': 'Administrator profiles cannot be disabled here.',
  'you cannot delete your own account': 'You cannot delete your own profile.',
  'cannot delete the last admin': 'The last administrator cannot be deleted.',
  'no such code': 'This invite code no longer exists. Refresh the invite list.',
  'already used, cannot revoke': 'This invite code has already been used and cannot be revoked.',
}
export function adminError(error) {
  const code = typeof error === 'string' ? error : error?.data?.code || error?.data?.error || error?.code
  if (messages[code]) return messages[code]
  if (error?.status === 429) return messages.locked
  if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') return 'The identity prompt was cancelled or timed out.'
  return typeof error === 'string' ? error : error?.message || 'The request failed. Try again.'
}
export const adminErrorVocabulary = [...Object.values(messages), 'The identity prompt was cancelled or timed out.', 'The request failed. Try again.']
