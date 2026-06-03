import CryptoJS from 'crypto-js';

const ALGORITHM = CryptoJS.AES;

export function encryptToHex(plaintext: string, nonce: string): string {
    const nonceWordArray = CryptoJS.lib.WordArray.create(b64ToUint8Array(nonce));
    const iv = CryptoJS.lib.WordArray.random(16);
    const cipherOutput: CryptoJS.lib.CipherParams = ALGORITHM.encrypt(plaintext, nonceWordArray, { iv: iv });
    return `${iv.toString(CryptoJS.enc.Hex)}:${cipherOutput.toString(CryptoJS.format.Hex)}`;
}

export function decryptFromHex(ciphertext: string, nonce: string): string {
    const ciphertextParts = ciphertext.split(':');
    if (ciphertextParts.length !== 2) {
        throw new Error(`Invalid ciphertext received: ${ciphertext}`)
    }
    const [iv, cipherParamText] = ciphertextParts.map((part) => CryptoJS.enc.Hex.parse(part));
    const nonceWordArray = CryptoJS.lib.WordArray.create(b64ToUint8Array(nonce));
    const cipherParam = CryptoJS.lib.CipherParams.create({ ciphertext: cipherParamText });
    const decipherOutput: CryptoJS.lib.WordArray = ALGORITHM.decrypt(cipherParam, nonceWordArray, { iv: iv });
    return decipherOutput.toString(CryptoJS.enc.Utf8);
}

function b64ToUint8Array(input: string): Uint8Array {
    const byteChars = atob(input);
    const arr = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
        arr[i] = byteChars.charCodeAt(i);
    }
    return arr;
}