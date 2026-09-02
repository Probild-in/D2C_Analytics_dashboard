import { SignJWT, jwtVerify } from "jose";

export interface StatePayload {
  clientId: string;
  platform: string;
  teamMemberId: string;
}

function getSecret(): Uint8Array {
  const secret = process.env.STATE_SIGNING_SECRET;
  if (!secret) {
    throw new Error("STATE_SIGNING_SECRET environment variable must be set");
  }
  return new TextEncoder().encode(secret);
}

export async function signState(payload: StatePayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(getSecret());
}

export async function verifyState(token: string): Promise<StatePayload> {
  const { payload } = await jwtVerify(token, getSecret());
  return {
    clientId: payload.clientId as string,
    platform: payload.platform as string,
    teamMemberId: payload.teamMemberId as string,
  };
}
