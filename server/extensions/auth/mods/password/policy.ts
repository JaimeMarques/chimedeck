// Password policy shared by password-setting flows.

// [why] bcrypt work is bounded by Bun's pre-hash, but an unbounded body still
// costs parsing and hashing time; no real password approaches this length.
export const MAX_PASSWORD_LENGTH = 1024;

// Same rule as reset-password: at least 8 characters, a letter and a digit.
export function isPasswordStrongEnough(password: string): boolean {
  return password.length >= 8 && /[a-zA-Z]/.test(password) && /[0-9]/.test(password);
}
