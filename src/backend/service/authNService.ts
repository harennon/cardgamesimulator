import crypto from "crypto";
import argon2 from "argon2";
import jwt, { JsonWebTokenError, TokenExpiredError } from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";

import { PostgresDB } from "@/database/postgres";
import { decryptFromHex } from "@shared/crypto";
import { AccountPayload } from "@shared/model";
import { AccessDeniedError, InternalServerError } from "@/util/errors";

export interface AuthNJWTPayload {
    jti: string,
    iss: string,
    sub: string,
    aud: string,
    iat: number,
    exp: number,
    nbf: number,
    preferred_username: string,
}

const SESSION_TIME_SECONDS = 3600 // 1 hour

export class AuthNService {
    public static INSTANCE: AuthNService = new AuthNService();

    private readonly JWT_SECRET_SALT: string;

    constructor() {
        this.JWT_SECRET_SALT = crypto.randomBytes(32).toString('base64');
    }

    public async createAccount(authRequestId: string, encryptedPayload: string): Promise<string> {
        const db = PostgresDB.INSTANCE;
        // get associated nonce for authN request
        const nonce = await db.getAndRemoveNonce(authRequestId);

        // decrypt account info using associated nonce
        const plaintext = decryptFromHex(encryptedPayload, nonce);
        const payload: AccountPayload = JSON.parse(plaintext);

        // salt and hash password
        const saltedPassword = await argon2.hash(payload.password);

        // persist account and password
        const account = await db.createAccount(payload.username, saltedPassword);

        return this.generateAuthNToken(account.accountId, account.username);
    }

    public async signInAccount(authRequestId: string, encryptedPayload: string): Promise<string> {
        const db = PostgresDB.INSTANCE;
        // get associated nonce for authN request
        const nonce = await db.getAndRemoveNonce(authRequestId);

        // decrypt account info using associated nonce
        const plaintext = decryptFromHex(encryptedPayload, nonce);
        const payload: AccountPayload = JSON.parse(plaintext);

        // get account if exists to verify
        const account = await db.getAccount(payload.username);
        if (account == null) {
            console.debug("Account does not exist")
            throw new AccessDeniedError();
        }

        // verify hash matches password
        const correctPassword = await argon2.verify(account.password, payload.password);
        if (!correctPassword) {
            console.debug("Account password mismatch");
            throw new AccessDeniedError();
        }

        return this.generateAuthNToken(account.accountId, account.username);
    }

    private generateAuthNToken(accountId: string, username: string): string {
        const now = Math.floor(Date.now() / 1000);
        const payload: AuthNJWTPayload = {
            sub: accountId,
            aud: 'http://frontend:80',
            iss: 'http://backend:3000/auth',
            iat: now,
            nbf: now - 1,
            exp: now + SESSION_TIME_SECONDS,
            jti: uuidv4(),
            preferred_username: username,
        }

        return jwt.sign(payload, this.JWT_SECRET_SALT, { algorithm: 'HS256' });
    }

    public verifyAuthNToken(token: string): AuthNJWTPayload {
        const now = Math.floor(Date.now() / 1000);
        try {
            const decoded = jwt.verify(token, this.JWT_SECRET_SALT, {
                algorithms: ['HS256'],
                audience: 'http://frontend:80',
                issuer: 'http://backend:3000/auth',
                clockTolerance: 5,
                clockTimestamp: now,
                maxAge: SESSION_TIME_SECONDS,
            });

            if (typeof decoded === "string") {
                return JSON.parse(decoded) as AuthNJWTPayload;
            } else {
                return decoded as AuthNJWTPayload;
            }
        } catch (error) {
            if (error instanceof JsonWebTokenError) {
                console.debug("Invalid jwt received:\n" + error);
                throw new AccessDeniedError();
            }
        }

        throw new InternalServerError();
    }
}