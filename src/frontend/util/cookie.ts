export function setJWTCookie(jwt: string, expiresInSeconds: number) {
    const date = new Date();
    date.setTime(date.getTime() + expiresInSeconds * 1000);
    document.cookie = `jwt=${jwt}; expires=${date.toUTCString()}; path=/`
}

export function getJWTCookie(): string {
    const decodedCookie = decodeURIComponent(document.cookie);
    const cookies = decodedCookie.split(';').map((part: string) => part.trim());
    const jwtCookie = cookies.find((part: string) => part.indexOf("jwt") === 0 );

    return jwtCookie ? jwtCookie.substring(jwtCookie.indexOf("=") + 1, jwtCookie.length) : "";
}

export function getUsernameFromJwtCookie(): string {
    const jwt = getJWTCookie().split('.');
    if (jwt.length === 3) {
        const payload = JSON.parse(atob(jwt[1]));

        return payload['preferred_username'] ? payload['preferred_username'] : "" ;
    }

    return "";
}

export function getAccountIdFromJwtCookie(): string {
    const jwt = getJWTCookie().split('.');
    if (jwt.length === 3) {
        const payload = JSON.parse(atob(jwt[1]));

        return payload['sub'] ? payload['sub'] : "" ;
    }

    return "";
}
