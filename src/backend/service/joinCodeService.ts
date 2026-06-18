import { randomBytes } from "crypto";

const CODE_LENGTH = 4;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateJoinCode(): string {
  const alphabetLength = ALPHABET.length;
  const threshold = Math.floor(256 / alphabetLength) * alphabetLength;
  let code = "";
  while (code.length < CODE_LENGTH) {
    const bytes = randomBytes(CODE_LENGTH);
    for (let i = 0; i < bytes.length && code.length < CODE_LENGTH; i++) {
      if (bytes[i] < threshold) {
        code += ALPHABET[bytes[i] % alphabetLength];
      }
    }
  }
  return code;
}
