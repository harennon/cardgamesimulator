import { v4 as uuidv4 } from 'uuid';

import { axiosInstance } from '@/main';
import { 
    AccountPayload, 
    GetNonceRequest,
    GetNonceResponse, 
    GetAuthTokenRequest, 
    GetAuthTokenResponse,
    CreateAccountRequest,
    CreateAccountResponse,
} from '@shared/model';
import { encryptToHex } from '@shared/crypto';
import { setJWTCookie } from '@/util/cookie';
import { AxiosResponse } from 'axios';

export abstract class AuthNService {
    /**
     * Authenticates user using given username and password.
     * If login attempt succeeds, the returned auth token is save to
     * cookie and default auth headers.
     * 
     * @param username client specified username
     * @param password client specified password
     * @returns jwt promise
     */
    public static async login(username: string, password: string): Promise<string> {
        const requestId = uuidv4();
        console.log(`Starting login process. RequestId: ${requestId}`);
        // get nonce to encrypt password with
        const getNonceRequest: GetNonceRequest = {
            authRequestId: requestId,
        }
        const getNonceResponse = await axiosInstance.get<GetNonceResponse>('/api/auth/getNonce', { params: getNonceRequest });
        
        // serialize and encrypt authModel
        const payloadModel: AccountPayload = {
            username: username,
            password: password,
        };
        const encryptedPassword = encryptToHex(JSON.stringify(payloadModel), getNonceResponse.data.nonce);

        // send login request
        const loginRequest: GetAuthTokenRequest = {
            authRequestId: requestId,
            payload: encryptedPassword
        };

        return axiosInstance.post<GetAuthTokenResponse>('/api/auth/getAuthToken', loginRequest).then((response: AxiosResponse<GetAuthTokenResponse>) => {
            // set cookie and default auth headers
            setJWTCookie(response.data.jwt, 1800);
            axiosInstance.defaults.headers.common["Authorization"] = `Bearer ${response.data.jwt}`;
            console.log(`Set default headers for jwt ${response.data.jwt}`);

            return new Promise<string>((resolve, _reject) => resolve(response.data.jwt));
        });
    }

    /**
     * Creates and authNs for user using given username and password.
     * If signup attempt succeeds, the returned auth token is save to
     * cookie and default auth headers.
     * 
     * @param username client specified username
     * @param password client specified password
     * @returns jwt promise
     */
    public static async signup(username: string, password: string): Promise<string> {
        const requestId = uuidv4();
        // get nonce to encrypt password with
        const getNonceRequest: GetNonceRequest = {
            authRequestId: requestId,
        }
        const getNonceResponse = await axiosInstance.get<GetNonceResponse>('/api/auth/getNonce', { params: getNonceRequest });
        // serialize and encrypt authModel
        const payloadModel: AccountPayload = {
            username: username,
            password: password,
        };
        const encryptedPassword = encryptToHex(JSON.stringify(payloadModel), getNonceResponse.data.nonce);
    
        // send login request
        const createAccountRequest: CreateAccountRequest = {
            authRequestId: requestId,
            payload: encryptedPassword
        };
        return axiosInstance.post<CreateAccountResponse>('/api/auth/createAccount', createAccountRequest).then((response: AxiosResponse<CreateAccountResponse>) => {
            // set cookie and default auth headers
            setJWTCookie(response.data.jwt, 1800);
            axiosInstance.defaults.headers.common["Authorization"] = `Bearer ${response.data.jwt}`;
            return new Promise<string>((resolve, _reject) => resolve(response.data.jwt));
        });
    }
}