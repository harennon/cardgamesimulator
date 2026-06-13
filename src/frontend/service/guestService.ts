import { ref } from "vue";
import { axiosInstance } from "@/service/http";
import type {
  CreateGuestSessionRequest,
  CreateGuestSessionResponse,
  ClaimGuestSessionRequest,
  ClaimGuestSessionResponse,
} from "@shared/guest-types";

export interface GuestState {
  guestId: string;
  displayName: string;
  token: string;
  gameId: string;
}

const COOKIE_NAME = "guest_token";

const guestState = ref<GuestState | null>(null);

function setCookie(token: string, expiresAt: number): void {
  const expires = new Date(expiresAt).toUTCString();
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; expires=${expires}; path=/${secure}; SameSite=Strict`;
}

function getCookieValue(): string | null {
  const prefix = `${COOKIE_NAME}=`;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return null;
}

function deleteCookie(): void {
  document.cookie = `${COOKIE_NAME}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Strict`;
}

/**
 * Decode the base64url payload of a guest token without verifying HMAC.
 * The server verifies on every authenticated request; client-side decode is
 * only used to read guestId / gameId / expiresAt for session restoration.
 */
function decodeGuestTokenPayload(
  token: string,
): { guestId: string; gameId: string; expiresAt: number } | null {
  if (!token.startsWith("guest:")) return null;
  try {
    const encoded = token.slice(6);
    const decoded = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    const lastDot = decoded.lastIndexOf(".");
    if (lastDot === -1) return null;
    const payload = decoded.slice(0, lastDot);
    const parts = payload.split(".");
    if (parts.length !== 3) return null;
    const [guestId, gameId, expiresAtStr] = parts as [string, string, string];
    const expiresAt = parseInt(expiresAtStr, 10);
    if (isNaN(expiresAt)) return null;
    return { guestId, gameId, expiresAt };
  } catch {
    return null;
  }
}

/** Create a guest session for a specific game. Stores token in cookie. */
export async function createGuestSession(
  displayName: string,
  gameId: string,
): Promise<GuestState> {
  const requestBody: CreateGuestSessionRequest = { displayName, gameId };
  const { data } = await axiosInstance.post<CreateGuestSessionResponse>(
    "/api/guest/session",
    requestBody,
  );

  const payload = decodeGuestTokenPayload(data.token);
  const expiresAt = payload?.expiresAt ?? Date.now() + 4 * 60 * 60 * 1000;

  setCookie(data.token, expiresAt);

  const state: GuestState = {
    guestId: data.guestId,
    displayName: data.displayName,
    token: data.token,
    gameId: data.gameId,
  };
  guestState.value = state;
  return state;
}

/** Restore guest session from cookie on page refresh. Returns null if no cookie or expired. */
export function restoreGuestSession(): GuestState | null {
  const token = getCookieValue();
  if (!token) return null;

  const payload = decodeGuestTokenPayload(token);
  if (!payload) {
    deleteCookie();
    return null;
  }

  if (Date.now() > payload.expiresAt) {
    deleteCookie();
    return null;
  }

  // displayName is not encoded in the token — restore a minimal state
  // The server will supply the full display name on next authenticated request.
  const state: GuestState = {
    guestId: payload.guestId,
    displayName: "",
    token,
    gameId: payload.gameId,
  };
  guestState.value = state;
  return state;
}

/** Get the current guest token (for Socket.IO auth). Returns null if not a guest. */
export function getGuestToken(): string | null {
  return guestState.value?.token ?? null;
}

/** Clear the guest session (on logout or session expiry). */
export function clearGuestSession(): void {
  deleteCookie();
  guestState.value = null;
}

/** Claim the guest session for a newly registered account. */
export async function claimGuestSession(
  guestToken: string,
): Promise<{ gamesLinked: number }> {
  const requestBody: ClaimGuestSessionRequest = { guestToken };
  const { data } = await axiosInstance.post<ClaimGuestSessionResponse>(
    "/api/guest/claim",
    requestBody,
  );
  return { gamesLinked: data.gamesLinked };
}
